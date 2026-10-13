import { sessionCalendarAbi, vayleMarketAbi } from "@vayle/abi";
import { CALL, PUT, seriesId } from "@vayle/market";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import {
  BaseError,
  ContractFunctionRevertedError,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import type { Market } from "@vayle/markets";
import { CASH_SYMBOL } from "../../tokens.ts";
import { TokenLogo } from "../../ui/TokenLogo.tsx";
import { AssetSwitcher } from "../components/AssetSwitcher.tsx";
import { WeekCard } from "../components/StatCards.tsx";
import type { AppConfig } from "../config.ts";
import { addressUrl } from "../events.ts";
import {
  amountOf,
  dollars,
  easternClock,
  easternDate,
  easternMoment,
  easternTime,
  easternWeekday,
  feedDollars,
  unitOf,
} from "../format.ts";
import { EXTERNAL_ICON, NavIcon } from "../shell/nav.tsx";
import { useApp } from "../state.tsx";
import { useAsset } from "../useAsset.ts";
import { assetOf, type AssetView, type MarketView } from "../useMarket.ts";
import { BID_WINDOW, bidOpensAt, hasBatch, ladder, referenceLabel, type Epoch } from "../week.ts";
import "./market.css";
import { FALLBACK_URL, REPO_URL } from "../../links.ts";

// One market as the contracts report it: the week, the feed, what can stop it, its limits, the
// calendar ahead and the addresses behind all of it. Every value is a chain read. The switcher at
// the top picks the market.

const REFRESH_MS = 30_000;
const CLOSES_SHOWN = 4;
// Feed round IDs carry the aggregator phase in their top bits; the round itself is the low 64.
const AGGREGATOR_ROUND = (1n << 64n) - 1n;
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

// One side's limits, in raw units of the market's token.
interface Caps {
  readonly openSize: bigint;
  readonly walletSize: bigint;
  readonly seriesOpenInterest: bigint;
  readonly fillSize: bigint;
}

interface Maker {
  readonly address: Address;
  readonly teamOperated: boolean;
  // How many of the week's listed prices this maker holds the best bid on.
  readonly prices: number;
}

interface WeekBids {
  // The week these bids belong to, so a read from last week never passes for this one.
  readonly expiry: number;
  readonly listed: number;
  readonly makers: readonly Maker[];
}

interface MarketStatus {
  readonly block: bigint;
  readonly feedRound: bigint;
  readonly feedAnswer: bigint;
  readonly feedUpdatedAt: number;
  readonly paused: boolean;
  readonly assetPaused: boolean;
  // 0 when no halt is active.
  readonly haltedUntil: number;
  readonly haltDuration: bigint;
  readonly sellCaps: Caps;
  readonly buyCaps: Caps;
  readonly feeBps: number;
  readonly calendar: Address;
  readonly closes: readonly number[];
  // The calendar ran out before it listed CLOSES_SHOWN closes.
  readonly calendarEnds: boolean;
  // Null when no week was open at the read.
  readonly bids: WeekBids | null;
}

type StatusState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly read: MarketStatus; readonly problem: string | null }
  | { readonly phase: "failed"; readonly reason: string };

function failureOf(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}

function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? null) : null;
}

async function readBids(
  client: PublicClient,
  config: AppConfig,
  market: Market,
  epoch: Epoch,
  blockNumber: bigint,
): Promise<WeekBids> {
  const rungs = ladder(epoch);
  const best = await Promise.all(
    rungs.map((rung) => {
      const side = rung.side === "sell" ? CALL : PUT;
      const series = seriesId({
        chainId: BigInt(config.chainId),
        asset: market.token,
        side,
        strike: rung.strike,
        expiry: BigInt(epoch.expiry),
        windowLength: epoch.windowLength,
        collateralToken: side === CALL ? market.token : config.usdg,
      });
      return client.readContract({
        address: config.market,
        abi: vayleMarketAbi,
        functionName: "bestBid",
        args: [series],
        blockNumber,
      });
    }),
  );
  const prices = new Map<Address, number>();
  for (const bid of best) {
    if (bid.maker !== zeroAddress) prices.set(bid.maker, (prices.get(bid.maker) ?? 0) + 1);
  }
  const makers = await Promise.all(
    [...prices].map(async ([address, count]) => ({
      address,
      prices: count,
      teamOperated: await client.readContract({
        address: config.market,
        abi: vayleMarketAbi,
        functionName: "teamOperated",
        args: [address],
        blockNumber,
      }),
    })),
  );
  return { expiry: epoch.expiry, listed: rungs.length, makers };
}

// Each close is found from the one before it, so these reads go one at a time.
async function readCloses(
  client: PublicClient,
  calendar: Address,
  from: number,
  blockNumber: bigint,
): Promise<{ readonly closes: number[]; readonly ends: boolean }> {
  const closes: number[] = [];
  let after = BigInt(from);
  while (closes.length < CLOSES_SHOWN) {
    try {
      after = await client.readContract({
        address: calendar,
        abi: sessionCalendarAbi,
        functionName: "nextCloseAfter",
        args: [after],
        blockNumber,
      });
    } catch (error) {
      if (revertName(error) === "NoCloseAfter") return { closes, ends: true };
      throw error;
    }
    closes.push(Number(after));
  }
  return { closes, ends: false };
}

// Every read is pinned to one block, so the values on the page agree with each other.
async function readStatus(
  client: PublicClient,
  config: AppConfig,
  asset: Market,
  epoch: Epoch | null,
  now: number,
): Promise<MarketStatus> {
  const blockNumber = await client.getBlockNumber();
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const calendarRead = client.readContract({ ...market, functionName: "calendar" });
  const [
    round,
    paused,
    assetPaused,
    haltedUntil,
    haltDuration,
    sellCaps,
    buyCaps,
    feeBps,
    calendar,
    { closes, ends },
    bids,
  ] = await Promise.all([
    client.readContract({
      address: asset.feed,
      abi: feedAbi,
      functionName: "latestRoundData",
      blockNumber,
    }),
    client.readContract({ ...market, functionName: "paused" }),
    client.readContract({ ...market, functionName: "assetPaused", args: [asset.token] }),
    client.readContract({ ...market, functionName: "haltedUntil" }),
    client.readContract({ ...market, functionName: "HALT_DURATION" }),
    client.readContract({ ...market, functionName: "capsOf", args: [asset.token, CALL] }),
    client.readContract({ ...market, functionName: "capsOf", args: [asset.token, PUT] }),
    client.readContract({ ...market, functionName: "feeBps" }),
    calendarRead,
    calendarRead.then((address) => readCloses(client, address, now, blockNumber)),
    epoch === null ? Promise.resolve(null) : readBids(client, config, asset, epoch, blockNumber),
  ]);
  return {
    block: blockNumber,
    feedRound: round[0] & AGGREGATOR_ROUND,
    feedAnswer: round[1],
    feedUpdatedAt: Number(round[3]),
    paused,
    assetPaused,
    haltedUntil: Number(haltedUntil),
    haltDuration,
    sellCaps,
    buyCaps,
    feeBps,
    calendar,
    closes,
    calendarEnds: ends,
    bids,
  };
}

// The chain is the external system: read on mount and every 30 seconds, and straight away when a
// new week opens. A failed read keeps the last result and says so. The board is keyed by its
// market, so another market's read never stands in for this one.
function useMarketStatus(
  client: PublicClient,
  config: AppConfig,
  asset: AssetView,
  now: number,
): StatusState {
  const [status, setStatus] = useState<StatusState>({ phase: "loading" });
  const expiry = asset.epoch?.expiry ?? null;
  // The shared view refreshes every 15 seconds. Reading its latest week and chain time here keeps
  // those refreshes from restarting this clock.
  const readLatest = useEffectEvent((client: PublicClient, config: AppConfig) =>
    readStatus(client, config, asset.market, asset.epoch, now),
  );
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const load = (): void => {
      if (running) return;
      running = true;
      readLatest(client, config)
        .then(
          (read) => {
            if (!cancelled) setStatus({ phase: "ready", read, problem: null });
          },
          (error: unknown) => {
            if (cancelled) return;
            const reason = failureOf(error);
            setStatus((previous) =>
              previous.phase === "ready"
                ? { ...previous, problem: reason }
                : { phase: "failed", reason },
            );
          },
        )
        .finally(() => {
          running = false;
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, config, expiry]);
  return status;
}

// Display helpers

function plural(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

function withRest(whole: string, rest: number, unit: string): string {
  return rest === 0 ? whole : `${whole} and ${plural(rest, unit)}`;
}

// How long ago, cut to the two largest units.
function since(seconds: number): string {
  if (seconds < 60) return "Under a minute ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${withRest(plural(hours, "hour"), minutes % 60, "minute")} ago`;
  const days = Math.floor(hours / 24);
  return `${withRest(plural(days, "day"), hours % 24, "hour")} ago`;
}

function lasting(seconds: bigint): string {
  const hours = Number(seconds / 3600n);
  const minutes = Number((seconds % 3600n) / 60n);
  return withRest(plural(hours, "hour"), minutes, "minute");
}

// Basis points as a percent, exactly: 1000 is 10%, 25 is 0.25%.
function percent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const hundredths = bps % 100;
  if (hundredths === 0) return `${whole}%`;
  return `${whole}.${hundredths.toString().padStart(2, "0").replace(/0$/, "")}%`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// What a card says while it has nothing current to show: still reading, or the read failed.
function waiting(status: StatusState, what: string): string {
  const failed = status.phase === "failed" || (status.phase === "ready" && status.problem !== null);
  return failed ? `Couldn't read ${what}.` : `Reading ${what}.`;
}

const SENTENCE_END = /[.!?]$/;

// A reason from an error, ended as a sentence so more text can follow it.
function sentence(text: string): string {
  return SENTENCE_END.test(text) ? text : `${text}.`;
}

function readOf(status: StatusState): MarketStatus | null {
  return status.phase === "ready" ? status.read : null;
}

// Pieces

function AddressText({
  config,
  address,
  short,
}: {
  readonly config: AppConfig;
  readonly address: Address;
  readonly short: boolean;
}) {
  const href = addressUrl(config, address);
  const text = short ? shortAddress(address) : address;
  const title = short ? address : undefined;
  return href === null ? (
    <span className="mk-address num" title={title}>
      {text}
    </span>
  ) : (
    <a className="mk-address mk-address-link num" href={href} title={title}>
      {text}
    </a>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="mk-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReadNote({
  status,
  view,
  readError,
}: {
  readonly status: StatusState;
  readonly view: MarketView;
  readonly readError: string | null;
}) {
  let line: ReactNode;
  if (status.phase === "loading") {
    line = <p className="mk-read">Reading the market from the chain.</p>;
  } else if (status.phase === "failed") {
    line = (
      <p className="mk-read mk-read-problem">
        Can&apos;t read the market&apos;s status right now: {sentence(status.reason)} It tries again
        every 30 seconds.
      </p>
    );
  } else if (status.problem !== null) {
    line = (
      <p className="mk-read mk-read-problem">
        The latest read failed, so what&apos;s shown is from block {status.read.block.toString()}:{" "}
        {sentence(status.problem)}
      </p>
    );
  } else {
    line = (
      <p className="mk-read">
        Read from the chain at block {status.read.block.toString()}. It reads again every 30
        seconds.
      </p>
    );
  }
  return (
    <div className="mk-notes">
      {line}
      {readError !== null && (
        <p className="mk-read mk-read-problem">
          The latest read of the week failed, so it&apos;s from block {view.block.toString()}:{" "}
          {sentence(readError.split("\n")[0] ?? readError)}
        </p>
      )}
    </div>
  );
}

// Said at the top when something has stopped, since it changes what anyone can do.
function StopNotice({
  read,
  now,
  symbol,
}: {
  readonly read: MarketStatus;
  readonly now: number;
  readonly symbol: string;
}) {
  let text: string | null = null;
  if (read.haltedUntil > now) {
    text = `The market is halted until ${easternTime(read.haltedUntil)}. Nothing can be set, stopped, settled or withdrawn until then.`;
  } else if (read.paused) {
    text = "New targets and fills are paused. Stopping, settling and withdrawing still work.";
  } else if (read.assetPaused) {
    text = `New ${symbol} targets and fills are paused. Stopping, settling and withdrawing still work.`;
  }
  if (text === null) return null;
  return (
    <p className="mk-stop" role="status">
      {text}
    </p>
  );
}

function FeedCard({
  asset,
  now,
  status,
}: {
  readonly asset: AssetView;
  readonly now: number;
  readonly status: StatusState;
}) {
  const read = readOf(status);
  return (
    <article className="card stat" aria-labelledby="mk-feed-title">
      <div className="stat-head">
        <div>
          <h2 id="mk-feed-title" className="stat-title mk-stat-title">
            Price feed
          </h2>
          <p className="stat-note">Chainlink {asset.market.symbol}/USD</p>
        </div>
      </div>
      {read === null ? (
        <p className="stat-empty">{waiting(status, "the feed")}</p>
      ) : (
        <>
          {read.feedAnswer > 0n ? (
            <p className="figure num">{feedDollars(read.feedAnswer, asset.feedDecimals)}</p>
          ) : (
            <p className="stat-empty">The feed&apos;s latest answer isn&apos;t a usable price.</p>
          )}
          <dl className="mk-facts">
            <div className="mk-fact">
              <dt>Round</dt>
              <dd className="num">{read.feedRound.toString()}</dd>
            </div>
            <div className="mk-fact">
              <dt>Updated</dt>
              <dd>
                {easternTime(read.feedUpdatedAt)}
                <span className="mk-sub">{since(Math.max(0, now - read.feedUpdatedAt))}</span>
              </dd>
            </div>
          </dl>
          <p className="stat-caption">
            {asset.epoch !== null && !hasBatch(asset.epoch)
              ? "This week's prices start from the last price the feed posted before it opened."
              : "Each week starts from the last price the feed posted before the close."}
          </p>
        </>
      )}
    </article>
  );
}

function sameEasternDay(a: number, b: number): boolean {
  return easternDate(a) === easternDate(b);
}

// When the stretch from `from` to `to` runs, with the second time cut to its clock on the same day.
function span(from: number, to: number): string {
  return `${easternTime(from)} to ${sameEasternDay(from, to) ? easternClock(to) : easternTime(to)}`;
}

function WeekRows({ epoch }: { readonly epoch: Epoch }) {
  const rungs = ladder(epoch);
  const sells = rungs.filter((r) => r.side === "sell").length;
  const bidOpen = bidOpensAt(epoch);
  const windowEnds = epoch.expiry + epoch.windowLength;
  return (
    <dl className="mk-rows">
      {hasBatch(epoch) ? (
        <>
          <Row label="Bid window">
            {span(bidOpen, bidOpen + BID_WINDOW)}
            <span className="mk-sub">The maker bids then, and the batch follows.</span>
          </Row>
          <Row label="Batch deadline">{easternTime(epoch.batchDeadline)}</Row>
          <Row label="Week ends">{easternTime(epoch.expiry)}</Row>
        </>
      ) : (
        <>
          <Row label="Fills by quote">
            {span(epoch.opening, epoch.expiry)}
            <span className="mk-sub">
              This week has no batch. A target fills when the maker quotes it.
            </span>
          </Row>
          <Row label="Week ends">{easternTime(epoch.expiry)}</Row>
          <Row label="Exercise window">{span(epoch.expiry, windowEnds)}</Row>
        </>
      )}
      <Row label="Prices listed">
        {plural(rungs.length, "price")}, {dollars(epoch.strikeTick)} apart
        <span className="mk-sub">
          {sells} to sell and {rungs.length - sells} to buy, within {percent(epoch.strikeRangeBps)}{" "}
          of the {referenceLabel(epoch).toLowerCase()}
        </span>
      </Row>
    </dl>
  );
}

function Bidders({
  config,
  asset,
  status,
}: {
  readonly config: AppConfig;
  readonly asset: AssetView;
  readonly status: StatusState;
}) {
  const e = asset.epoch;
  if (e === null) return <p className="mk-quiet">Bids start once the first week opens.</p>;
  if (!hasBatch(e)) {
    return <p className="mk-quiet">This week fills by quote, so it has no batch bids.</p>;
  }
  const bids = readOf(status)?.bids ?? null;
  // Bids read for an earlier week never stand in for this one.
  if (bids?.expiry !== e.expiry) {
    return <p className="mk-quiet">{waiting(status, "this week's bids")}</p>;
  }
  if (bids.makers.length === 0) return <p className="mk-quiet">No bids yet this week.</p>;
  return (
    <ul className="mk-makers">
      {bids.makers.map((maker) => (
        <li key={maker.address} className="mk-maker">
          <span className="mk-maker-who">
            <AddressText config={config} address={maker.address} short />
            <span className="chip chip-plain">
              Team-operated: {maker.teamOperated ? "yes" : "no"}
            </span>
          </span>
          <span className="mk-sub">
            {maker.prices === bids.listed
              ? `Top bid on all ${plural(bids.listed, "price")}`
              : `Top bid on ${maker.prices} of ${plural(bids.listed, "price")}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function WeekTimesCard({
  config,
  asset,
  status,
}: {
  readonly config: AppConfig;
  readonly asset: AssetView;
  readonly status: StatusState;
}) {
  return (
    <article className="card mk-card" aria-labelledby="mk-week-title">
      <div className="card-head">
        <h2 id="mk-week-title" className="h3">
          This week
        </h2>
      </div>
      {asset.epoch === null ? (
        <p className="empty-state">No {asset.market.symbol} week is open yet.</p>
      ) : (
        <WeekRows epoch={asset.epoch} />
      )}
      <section className="mk-section" aria-labelledby="mk-maker-title">
        <h3 id="mk-maker-title" className="mk-subhead">
          The maker
        </h3>
        <Bidders config={config} asset={asset} status={status} />
      </section>
    </article>
  );
}

function CloseList({
  read,
  asset,
  now,
  status,
}: {
  readonly read: MarketStatus;
  readonly asset: AssetView;
  readonly now: number;
  readonly status: StatusState;
}) {
  // Closes the chain has passed since the read drop out here, before the next read lands.
  const upcoming = read.closes.filter((close) => close > now);
  if (upcoming.length === 0) {
    return (
      <p className="empty-state">
        {read.calendarEnds
          ? "The calendar doesn't list any closes after now yet."
          : waiting(status, "the calendar")}
      </p>
    );
  }
  return (
    <>
      <ol className="mk-closes">
        {upcoming.map((close) => {
          const day = easternMoment(close);
          const tags: string[] = [];
          if (close === asset.epoch?.expiry) tags.push("This week ends");
          if (easternWeekday(close) === "Thursday") tags.push("Thursday close");
          if (day.hour === 13) tags.push("Early close");
          return (
            <li key={close} className="mk-close">
              <span className="mk-close-time">{easternTime(close)}</span>
              {tags.length > 0 && (
                <span className="mk-tags">
                  {tags.map((tag) => (
                    <span key={tag} className="chip chip-plain">
                      {tag}
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {read.calendarEnds && (
        <p className="mk-foot">The calendar doesn&apos;t list any closes after that yet.</p>
      )}
    </>
  );
}

function ClosesCard({
  asset,
  now,
  status,
}: {
  readonly asset: AssetView;
  readonly now: number;
  readonly status: StatusState;
}) {
  const read = readOf(status);
  return (
    <article className="card mk-card" aria-labelledby="mk-closes-title">
      <div className="card-head">
        <div>
          <h2 id="mk-closes-title" className="h3">
            Weekly closes
          </h2>
          <p className="card-sub">
            The next ones on the session calendar. Each week runs from one close to the next.
          </p>
        </div>
      </div>
      {read === null ? (
        <p className="empty-state">{waiting(status, "the calendar")}</p>
      ) : (
        <CloseList read={read} asset={asset} now={now} status={status} />
      )}
    </article>
  );
}

function ControlsCard({
  symbol,
  now,
  status,
}: {
  readonly symbol: string;
  readonly now: number;
  readonly status: StatusState;
}) {
  const read = readOf(status);
  return (
    <article className="card mk-card" aria-labelledby="mk-controls-title">
      <div className="card-head">
        <div>
          <h2 id="mk-controls-title" className="h3">
            Controls
          </h2>
          <p className="card-sub">What can stop the market, and whether it has.</p>
        </div>
      </div>
      {read === null ? (
        <p className="empty-state">{waiting(status, "the controls")}</p>
      ) : (
        <dl className="mk-rows">
          <Row label="New targets">
            {read.paused ? (
              <span className="chip chip-problem">Paused</span>
            ) : (
              <span className="chip chip-plain">Open</span>
            )}
          </Row>
          <Row label={`${symbol} targets`}>
            {read.assetPaused ? (
              <span className="chip chip-problem">Paused</span>
            ) : (
              <span className="chip chip-plain">Not paused</span>
            )}
          </Row>
          <Row label="Emergency halt">
            {read.haltedUntil > now ? (
              <span className="mk-halt">
                <span className="chip chip-problem">Halted</span> until{" "}
                {easternTime(read.haltedUntil)}
              </span>
            ) : (
              <span className="chip chip-plain">No halt</span>
            )}
          </Row>
          <Row label="A halt lasts">Up to {lasting(read.haltDuration)}</Row>
        </dl>
      )}
    </article>
  );
}

const LIMITS: readonly { readonly label: string; readonly key: keyof Caps }[] = [
  { label: "All open targets", key: "openSize" },
  { label: "Per wallet", key: "walletSize" },
  { label: "Per week", key: "seriesOpenInterest" },
  { label: "Per fill", key: "fillSize" },
];

function LimitsCard({ market, status }: { readonly market: Market; readonly status: StatusState }) {
  const read = readOf(status);
  const unit = unitOf(market);
  const amount = (raw: bigint): string => amountOf(raw, unit);
  const anyZero =
    read !== null &&
    LIMITS.some(({ key }) => read.sellCaps[key] === 0n || read.buyCaps[key] === 0n);
  return (
    <article className="card mk-card" aria-labelledby="mk-limits-title">
      <div className="card-head">
        <div>
          <h2 id="mk-limits-title" className="h3">
            Limits
          </h2>
          <p className="card-sub">How much the market takes on each side, set onchain.</p>
        </div>
      </div>
      {read === null ? (
        <p className="empty-state">{waiting(status, "the limits")}</p>
      ) : (
        <>
          <table className="mk-limits">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Limit</span>
                </th>
                <th scope="col">Sell targets</th>
                <th scope="col">Buy targets</th>
              </tr>
            </thead>
            <tbody>
              {LIMITS.map(({ label, key }) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td className="num" data-label="Sell targets">
                    {amount(read.sellCaps[key])}
                  </td>
                  <td className="num" data-label="Buy targets">
                    {amount(read.buyCaps[key])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mk-note">
            Per week counts each price on its own, and buy targets count the {market.symbol}{" "}
            they&apos;d buy.
            {anyZero && " A limit of zero closes that side."}
          </p>
          <section className="mk-section mk-fee" aria-labelledby="mk-fee-title">
            <div className="mk-fee-line">
              <h3 id="mk-fee-title" className="mk-subhead">
                Fee
              </h3>
              <p className="mk-fee-value">{percent(read.feeBps)} of each payment</p>
            </div>
            <p className="mk-sub">The maker pays it on top, so you get the whole payment.</p>
          </section>
        </>
      )}
    </article>
  );
}

function ContractRow({
  name,
  icon,
  children,
}: {
  readonly name: string;
  // The ticker of the token the contract is, when it is one.
  readonly icon: string | null;
  readonly children: ReactNode;
}) {
  return (
    <li className="mk-contract">
      <span className="mk-contract-icon">
        {icon !== null && <TokenLogo symbol={icon} size="sm" />}
      </span>
      <span className="mk-contract-name">{name}</span>
      {children}
    </li>
  );
}

function ContractsCard({
  config,
  market,
  status,
}: {
  readonly config: AppConfig;
  readonly market: Market;
  readonly status: StatusState;
}) {
  const read = readOf(status);
  return (
    <article
      className="card mk-card mk-wide mk-contracts-card"
      aria-labelledby="mk-contracts-title"
    >
      <div className="card-head">
        <div>
          <h2 id="mk-contracts-title" className="h3">
            Contracts
          </h2>
          <p className="card-sub">
            Every number on this page comes from these contracts on Robinhood Chain.
          </p>
        </div>
      </div>
      <ul className="mk-contracts">
        <ContractRow name="Market" icon={null}>
          <AddressText config={config} address={config.market} short={false} />
        </ContractRow>
        <ContractRow name={`${market.symbol} Stock Token`} icon={market.symbol}>
          <AddressText config={config} address={market.token} short={false} />
        </ContractRow>
        <ContractRow name={CASH_SYMBOL} icon={CASH_SYMBOL}>
          <AddressText config={config} address={config.usdg} short={false} />
        </ContractRow>
        <ContractRow name={`Chainlink ${market.symbol}/USD feed`} icon={null}>
          <AddressText config={config} address={market.feed} short={false} />
        </ContractRow>
        <ContractRow name="Session calendar" icon={null}>
          {read === null ? (
            <span className="mk-quiet">{waiting(status, "its address")}</span>
          ) : (
            <AddressText config={config} address={read.calendar} short={false} />
          )}
        </ContractRow>
      </ul>
      <div className="mk-links">
        <a className="btn btn-outline btn-sm" href={REPO_URL}>
          <NavIcon d={EXTERNAL_ICON} />
          Source code
        </a>
        <a className="btn btn-outline btn-sm" href={FALLBACK_URL}>
          <NavIcon d={EXTERNAL_ICON} />
          Fallback page
        </a>
      </div>
      <p className="mk-foot">
        The fallback page is one file that settles, cancels and withdraws through your own wallet,
        with no Vayle server involved.
      </p>
    </article>
  );
}

function MarketBoard({ view, asset }: { readonly view: MarketView; readonly asset: AssetView }) {
  const { config, client, readError } = useApp();
  const status = useMarketStatus(client, config, asset, view.now);
  const read = readOf(status);
  const { market } = asset;
  return (
    <>
      <ReadNote status={status} view={view} readError={readError} />
      {read !== null && <StopNotice read={read} now={view.now} symbol={market.symbol} />}
      <div className="mk-board">
        <section className="mk-lead" aria-labelledby="mk-lead-title">
          <h2 id="mk-lead-title" className="visually-hidden">
            Where this week stands
          </h2>
          <WeekCard asset={asset} now={view.now} />
        </section>
        <FeedCard asset={asset} now={view.now} status={status} />
        <WeekTimesCard config={config} asset={asset} status={status} />
        <LimitsCard market={market} status={status} />
        <ControlsCard symbol={market.symbol} now={view.now} status={status} />
        <ClosesCard asset={asset} now={view.now} status={status} />
        <ContractsCard config={config} market={market} status={status} />
      </div>
    </>
  );
}

export function MarketPage(): ReactNode {
  const { config, view } = useApp();
  const { market } = useAsset();
  if (view === null) return null;
  const asset = assetOf(view, market.token);
  if (asset === undefined) return null;
  return (
    <>
      {config.markets.length > 1 && (
        <div className="page-head">
          <AssetSwitcher />
        </div>
      )}
      <MarketBoard key={market.token} view={view} asset={asset} />
    </>
  );
}
