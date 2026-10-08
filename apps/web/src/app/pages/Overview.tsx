import type { MarketEvent, OrderState } from "@vayle/market";
import { formatFixed } from "@vayle/units";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { TickerBadge } from "../../ui/TickerBadge.tsx";
import { Holdings } from "../components/Holdings.tsx";
import { actionFor, lineOf, OrderBadge, type Action } from "../components/Orders.tsx";
import { PriceCard } from "../components/PriceCard.tsx";
import { WeekTrack } from "../components/WeekTrack.tsx";
import type { AppConfig } from "../config.ts";
import { contextOf, describeEvent, txUrl, type EventLine } from "../events.ts";
import { dollars, easternTime, premium } from "../format.ts";
import { nameOf, type OrderLine } from "../orders.ts";
import { sheetRows, type SheetRow } from "../rates.ts";
import { useApp, type Run } from "../state.tsx";
import { useAsset } from "../useAsset.ts";
import { assetOf, type AccountView, type AssetView } from "../useMarket.ts";
import type { MarketHistory } from "../useMarketHistory.ts";
import { usePriceHistory } from "../usePriceHistory.ts";
import { ladder, referenceLabel, type Epoch, type Rung } from "../week.ts";
import "./overview.css";

// The holder's home: one market's price beside everything they hold, where that market's week
// stands, what needs them, their targets on every market and what happened to them, and the week's
// prices with the maker's bids. Everything shown comes from the shared market read, the feed's
// rounds or the holder's history.

const SHOWN_ORDERS = 4;
const SHOWN_EVENTS = 5;
const RUNGS_EACH_SIDE = 3;

interface Entry {
  readonly order: OrderState;
  readonly line: OrderLine;
}

interface Needed extends Entry {
  readonly action: Action;
}

interface Happened {
  readonly event: MarketEvent;
  readonly line: EventLine;
}

type PendingHistory = Exclude<MarketHistory, { readonly status: "ready" }>;

function newestFirst(a: Entry, b: Entry): number {
  if (a.order.id === b.order.id) return 0;
  return a.order.id < b.order.id ? 1 : -1;
}

function priceKey(side: Rung["side"], strike: bigint): string {
  return `${side}:${strike.toString()}`;
}

// The holder's active targets on one market.
function activeOn(account: AccountView, asset: AssetView): OrderState[] {
  return account.orders.filter((o) => o.status === "active" && o.asset === asset.market.token);
}

// The prices the holder's active targets on a market stand at, so the week's prices can mark them
// as theirs.
function heldPrices(account: AccountView, asset: AssetView): Set<string> {
  return new Set(
    activeOn(account, asset).map((o) => priceKey(o.side === 0 ? "sell" : "buy", o.target)),
  );
}

// The same prices for the chart's marks, without repeats.
function orderPrices(account: AccountView, asset: AssetView): bigint[] {
  return [...new Set(activeOn(account, asset).map((o) => o.target))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
}

// Errors from the chain client run on for lines of request detail. The first line says what failed.
function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function historyState(history: PendingHistory): string {
  switch (history.status) {
    case "idle":
      return "Connect a wallet to see your history.";
    case "off":
      return "History isn't shown in this build. It has no indexer and no deploy block to read from.";
    case "loading":
      return history.source === "indexer"
        ? "Loading your history from the indexer."
        : "Reading your history from the chain. The first read goes back to the market's deploy.";
    case "failed":
      return `History is unavailable right now: ${firstLine(history.reason)}`;
  }
}

function recentOf(events: readonly MarketEvent[], config: AppConfig): Happened[] {
  const context = contextOf(events, config.markets);
  return [...events]
    .reverse()
    .flatMap((event) => {
      const line = describeEvent(event, config, context);
      return line === null ? [] : [{ event, line }];
    })
    .slice(0, SHOWN_EVENTS);
}

export function OverviewPage(): ReactNode {
  const { config, client, view, wallet, onChain, history, run, busy, readError } = useApp();
  const { market, link } = useAsset();
  const prices = usePriceHistory(client, market.feed);
  if (view === null) return null;
  const asset = assetOf(view, market.token);
  if (asset === undefined) return null;
  const account = wallet.address === null ? null : view.account;

  const hero = (
    <div className="ov-hero">
      <PriceCard
        config={config}
        asset={asset}
        now={view.now}
        history={prices}
        marks={account === null ? [] : orderPrices(account, asset)}
      />
      {account !== null ? (
        <Holdings
          config={config}
          account={account}
          assets={view.assets}
          history={history}
          canAct={onChain}
          run={run}
          busy={busy}
        />
      ) : (
        <section className="card holdings holdings-empty" role="status">
          <p className="holdings-title">Your holdings</p>
          <p className="holdings-empty-line">
            {wallet.address === null
              ? "Connect a wallet to see your Stock Tokens and USDG, what's in your targets and what they've earned."
              : readError === null
                ? "Reading your holdings from the chain."
                : `Can't read your holdings right now: ${firstLine(readError)}`}
          </p>
          <Link className="ov-link" to={link("/trade")}>
            See this week&apos;s prices
          </Link>
        </section>
      )}
    </div>
  );

  if (account === null) {
    return (
      <>
        {hero}
        <WeekTrack epoch={asset.epoch} now={view.now} />
        <WeekPrices config={config} asset={asset} held={new Set()} link={link} />
      </>
    );
  }

  const entries = account.orders
    .map((order) => ({ order, line: lineOf(config, view, account, order) }))
    .sort(newestFirst);
  const needed = entries.flatMap((entry): Needed[] => {
    if (entry.line.action !== "settle" && entry.line.action !== "finalize-then-settle") return [];
    const action = actionFor(config, entry.order, entry.line);
    return action === null ? [] : [{ ...entry, action }];
  });
  const open = entries.filter(({ order }) => order.status === "active" || order.series !== 0n);

  return (
    <>
      {hero}
      <NeedsYou config={config} items={needed} canAct={onChain} run={run} busy={busy} />
      <WeekTrack epoch={asset.epoch} now={view.now} />
      <div className="ov-columns">
        <YourOrders
          config={config}
          entries={open.slice(0, SHOWN_ORDERS)}
          total={account.orders.length}
          link={link}
        />
        <RecentActivity config={config} history={history} link={link} />
      </div>
      <WeekPrices config={config} asset={asset} held={heldPrices(account, asset)} link={link} />
    </>
  );
}

// A card's title, the line under it when there is one, and what the card leads to.
function CardHead({
  title,
  sub,
  aside,
}: {
  readonly title: string;
  readonly sub: string | null;
  readonly aside: ReactNode;
}) {
  return (
    <div className="card-head ov-head">
      <h2 className="h3">{title}</h2>
      {sub !== null && <p className="card-sub">{sub}</p>}
      <div className="ov-head-aside">{aside}</div>
    </div>
  );
}

function NeedsYou({
  config,
  items,
  canAct,
  run,
  busy,
}: {
  readonly config: AppConfig;
  readonly items: readonly Needed[];
  readonly canAct: boolean;
  readonly run: Run;
  readonly busy: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="card ov-needs">
      <CardHead
        title="Needs you"
        sub={
          canAct
            ? "These weeks have ended. Settle each one to collect its result."
            : "Switch your wallet to Robinhood Chain to settle."
        }
        aside={
          <span className="card-count num">
            {items.length}
            <span className="visually-hidden"> to settle</span>
          </span>
        }
      />
      <ul className="ov-list ov-need-list">
        {items.map(({ order, line, action }) => (
          <li key={order.id.toString()} className="ov-need">
            <Link className="ov-name" to={`/orders/${order.id.toString()}`}>
              <OrderBadge config={config} order={order} size="md" />
              <span className="ov-name-text">{nameOf(line)}</span>
            </Link>
            <span className="ov-price num">{line.price}</span>
            <p className="ov-need-status">{line.status}</p>
            <button
              type="button"
              className="btn btn-ink btn-sm ov-need-action"
              aria-label={`${action.label} ${nameOf(line)} at ${line.price}`}
              disabled={busy || !canAct}
              onClick={() => void run(action.label, action.calls)}
            >
              {action.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function YourOrders({
  config,
  entries,
  total,
  link,
}: {
  readonly config: AppConfig;
  readonly entries: readonly Entry[];
  readonly total: number;
  readonly link: (path: string) => string;
}) {
  return (
    <section className="card ov-panel">
      <CardHead
        title="Your targets"
        sub={null}
        aside={
          <Link
            className="ov-link"
            to={link("/orders")}
            aria-label={`All targets, ${total} in total`}
          >
            All targets
            <span className="ov-count num">{total}</span>
          </Link>
        }
      />
      {entries.length === 0 ? (
        <p className="empty-state">
          No open targets.{" "}
          <Link className="ov-link" to={link("/trade")}>
            Choose a price
          </Link>{" "}
          to set one.
        </p>
      ) : (
        <ul className="ov-list ov-order-list">
          {entries.map(({ order, line }) => (
            <li key={order.id.toString()}>
              <Link className="ov-order" to={`/orders/${order.id.toString()}`}>
                <span className="ov-name">
                  <OrderBadge config={config} order={order} size="md" />
                  <span className="ov-name-text">{nameOf(line)}</span>
                </span>
                <span className="ov-price num">{line.price}</span>
                <span className={`chip chip-${line.chip.tone}`}>{line.chip.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// When it happened, linked to the transaction when the build knows an explorer. The cell always
// renders, so the amounts beside it stay in their column.
function EventTime({ config, event }: { readonly config: AppConfig; readonly event: MarketEvent }) {
  const seconds = Math.floor(Date.parse(event.block_time) / 1000);
  if (!Number.isFinite(seconds)) return <p className="ov-event-time" />;
  const time = <time dateTime={event.block_time}>{easternTime(seconds)}</time>;
  const url = txUrl(config, event.tx_hash);
  return <p className="ov-event-time">{url === null ? time : <a href={url}>{time}</a>}</p>;
}

function RecentActivity({
  config,
  history,
  link,
}: {
  readonly config: AppConfig;
  readonly history: MarketHistory;
  readonly link: (path: string) => string;
}) {
  const recent = history.status === "ready" ? recentOf(history.events, config) : [];
  const paid = recent.some(({ line }) => line.kind === "earned");
  return (
    <section className="card ov-panel">
      <CardHead
        title="Recent activity"
        sub={paid ? "Payments come from the maker Vayle operates." : null}
        aside={
          <Link className="ov-link" to={link("/activity")}>
            All activity
          </Link>
        }
      />
      {history.status !== "ready" ? (
        <p className="empty-state ov-state">{historyState(history)}</p>
      ) : recent.length === 0 ? (
        <p className="empty-state">Nothing has happened on your targets yet.</p>
      ) : (
        <ol className="ov-list ov-event-list">
          {recent.map(({ event, line }) => (
            <li key={`${event.block_number}:${event.log_index}`} className="ov-event">
              <p className="ov-event-title">
                {line.ticker !== null && <TickerBadge symbol={line.ticker} size="xs" named />}
                {line.title}
              </p>
              <EventTime config={config} event={event} />
              {line.amount !== null && (
                <p
                  className={
                    line.kind === "earned"
                      ? "ov-event-amount ov-event-earned num"
                      : "ov-event-amount num"
                  }
                >
                  {line.amount}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {history.status === "ready" && history.problem !== null && (
        <p className="ov-foot">
          The latest refresh failed, so this is as of block {history.toBlock.toString()}.
        </p>
      )}
    </section>
  );
}

// A bid as a share of what one token's target locks, in basis points, cut down.
function shareOf(bid: bigint, locks: bigint): bigint {
  return locks === 0n ? 0n : (bid * 10_000n) / locks;
}

function percent(bps: bigint): string {
  return `${(bps / 100n).toString()}.${(bps % 100n).toString().padStart(2, "0")}%`;
}

function RungLink({
  config,
  rung,
  bid,
  share,
  widest,
  mine,
  link,
}: {
  readonly config: AppConfig;
  readonly rung: Rung;
  readonly bid: bigint | undefined;
  // The bid as a share of what the target locks, and the largest share shown, in basis points.
  readonly share: bigint;
  readonly widest: bigint;
  readonly mine: boolean;
  readonly link: (path: string) => string;
}) {
  const selling = rung.side === "sell";
  return (
    <li>
      <Link
        className={mine ? "ov-rung ov-rung-mine" : "ov-rung"}
        to={link(`/trade?price=${formatFixed(rung.strike, config.usdgDecimals)}`)}
      >
        <span className="ov-rung-tags">
          <span className={selling ? "row-side side-sell" : "row-side side-buy"}>
            {selling ? "Sell" : "Buy"}
          </span>
          {mine && <span className="ov-mine">Your price</span>}
        </span>
        <span className="ov-rung-price num">{dollars(rung.strike)}</span>
        <span className="ov-rung-bid">
          {bid === undefined ? (
            "No bid yet"
          ) : (
            <>
              Bid <span className="ov-bid num">{premium(bid)}</span>
              <span className="ov-share num">{percent(share)} this week</span>
            </>
          )}
        </span>
        {bid !== undefined && widest > 0n && (
          <span className="ov-rung-meter" aria-hidden="true">
            <span style={{ width: `${Number((share * 100n) / widest)}%` }} />
          </span>
        )}
      </Link>
    </li>
  );
}

// What one token's target locks, priced in USDG: a sell target locks the token, at this week's
// reference, and a buy target locks its price.
function locksFor(rung: Rung, e: Epoch): bigint {
  return rung.side === "sell" ? e.referencePrice : rung.strike;
}

// One market's prices either side of the reference, highest first as on the ladder, each a way
// into the ticket. As on the rate sheet, a buy target shows only where there's a bid for it.
function WeekPrices({
  config,
  asset,
  held,
  link,
}: {
  readonly config: AppConfig;
  readonly asset: AssetView;
  readonly held: ReadonlySet<string>;
  readonly link: (path: string) => string;
}) {
  const { rates } = useApp();
  const e = asset.epoch;
  const inputs = rates(asset);
  const symbol = asset.market.symbol;
  const rows = e === null || inputs === null ? [] : sheetRows(ladder(e), inputs);
  const sells = rows.filter((r) => r.rung.side === "sell").slice(-RUNGS_EACH_SIDE);
  const buys = rows.filter((r) => r.rung.side === "buy").slice(0, RUNGS_EACH_SIDE);
  const shares = new Map(
    e === null
      ? []
      : [...sells, ...buys].map(({ rung, rate }) => {
          const share = rate === null ? 0n : shareOf(rate.premium, locksFor(rung, e));
          return [rung.strike, share] as const;
        }),
  );
  const widest = [...shares.values()].reduce((max, v) => (v > max ? v : max), 0n);
  const rungLink = ({ rung, rate }: SheetRow) => (
    <RungLink
      key={rung.strike.toString()}
      config={config}
      rung={rung}
      bid={rate?.premium}
      share={shares.get(rung.strike) ?? 0n}
      widest={widest}
      mine={held.has(priceKey(rung.side, rung.strike))}
      link={link}
    />
  );
  return (
    <section className="card ov-prices">
      <CardHead
        title={`This week's ${symbol} prices`}
        sub={`Nearest the ${e === null ? "close" : referenceLabel(e).toLowerCase()}, with each price's bid per ${symbol}.`}
        aside={
          <Link className="ov-link" to={link("/trade")}>
            Open the ladder
          </Link>
        }
      />
      {e === null ? (
        <p className="empty-state">{symbol}&apos;s ladder opens with its first week.</p>
      ) : (
        <>
          <ol className="ov-rungs">
            {sells.map(rungLink)}
            <li className="ov-close">
              <span className="close-pill num">
                {referenceLabel(e)} {dollars(e.referencePrice)}
              </span>
            </li>
            {buys.map(rungLink)}
          </ol>
          {widest > 0n && (
            <p className="ov-foot">
              Each share is the bid against what one target locks: one {symbol} at the{" "}
              {referenceLabel(e).toLowerCase()} to sell, or the price in USDG to buy.
            </p>
          )}
        </>
      )}
    </section>
  );
}
