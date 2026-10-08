import "./markets.css";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { TokenLogo } from "../../ui/TokenLogo.tsx";
import { withAsset } from "../assets.ts";
import { dollars, easternTime, premium } from "../format.ts";
import {
  notListed,
  type CheckStatus,
  type CheckedToken,
  type MarketCheck,
} from "../marketCheck.ts";
import { sheetRows, type SheetRow } from "../rates.ts";
import { useApp } from "../state.tsx";
import type { AssetView } from "../useMarket.ts";
import { useMarketCheck, type MarketCheckState } from "../useMarketCheck.ts";
import { hasBatch, ladder, phase, referenceLabel, type Epoch } from "../week.ts";

// Every Stock Token market: the live ones with their week, reference and rates, then every other
// Stock Token from the market check with what it found, each not listed yet. Rates come only from
// the chain and the maker's bid sheet, so a token that isn't listed never shows one.

const RATES_EACH_SIDE = 3;
const OTHERS_SHOWN = 40;

const CHECK_LABELS: Readonly<Record<string, string>> = {
  feed: "Price feed",
  erc8056: "ERC-8056",
  multiplier: "Multiplier",
  pauses: "Pauses",
  staleness: "Staleness",
  liquidity: "Liquidity",
  uid: "Registry ID",
};

// A check by its name, or by the key the file gives it when the app doesn't know it.
function labelOf(key: string): string {
  return CHECK_LABELS[key] ?? key;
}

const STATUS_LABELS: Readonly<Record<CheckStatus, string>> = {
  pass: "passed",
  fail: "failed",
  not_run: "not run",
};

const CHIP_TONES: Readonly<Record<CheckStatus, string>> = {
  pass: "chip",
  fail: "chip chip-problem",
  not_run: "chip chip-plain",
};

// Where a market's week stands, in a word or two, and whether it's a stretch where a holder's
// action counts now: the bid window, or a week that fills by quote.
function stageOf(
  epoch: Epoch | null,
  now: number,
): { readonly label: string; readonly active: boolean } {
  if (epoch === null) return { label: "First week to come", active: false };
  switch (phase(epoch, now)) {
    case "settling":
      return { label: "Settling last week", active: false };
    case "bidding":
      return { label: "Bid window", active: true };
    case "live":
      return hasBatch(epoch)
        ? { label: "This week", active: false }
        : { label: "Fills by quote", active: true };
    case "expired":
      return { label: "Week ended", active: false };
  }
}

function span(from: number, to: number): string {
  return `${easternTime(from)} to ${easternTime(to)}`;
}

function RateRows({
  rows,
  symbol,
}: {
  readonly rows: readonly SheetRow[];
  readonly symbol: string;
}) {
  if (rows.length === 0) return <p className="mkts-quiet">No prices listed this week.</p>;
  return (
    <ul className="mkts-rates" aria-label={`This week's rates per ${symbol}`}>
      {rows.map(({ rung, rate }) => (
        <li key={rung.strike.toString()} className="mkts-rate">
          <span className={rung.side === "sell" ? "row-side side-sell" : "row-side side-buy"}>
            {rung.side === "sell" ? "Sell" : "Buy"}
          </span>
          <span className="mkts-rate-price num">{dollars(rung.strike)}</span>
          <span className="mkts-rate-bid">
            {rate === null ? (
              "No bid yet"
            ) : (
              <>
                <span className="num">{premium(rate.premium)}</span>{" "}
                {rate.source === "batch" ? "batch bid" : "maker's bid"}
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LiveMarket({
  asset,
  name,
  now,
}: {
  readonly asset: AssetView;
  readonly name: string | null;
  readonly now: number;
}) {
  const { rates } = useApp();
  const { market, epoch } = asset;
  const inputs = rates(asset);
  const rows = epoch === null || inputs === null ? [] : sheetRows(ladder(epoch), inputs);
  const nearest = [
    ...rows.filter((r) => r.rung.side === "sell").slice(-RATES_EACH_SIDE),
    ...rows.filter((r) => r.rung.side === "buy").slice(0, RATES_EACH_SIDE),
  ];
  const stage = stageOf(epoch, now);
  const maker = inputs?.maker ?? null;
  return (
    <article className="card mkts-market" aria-labelledby={`mkts-${market.token}`}>
      <div className="mkts-market-head">
        <TokenLogo symbol={market.symbol} size="lg" />
        <div className="mkts-market-name">
          <h3 id={`mkts-${market.token}`} className="mkts-symbol">
            {market.symbol}
          </h3>
          <p className="mkts-sub">{name ?? "Stock Token on Robinhood Chain"}</p>
        </div>
        <span className={stage.active ? "chip chip-brand" : "chip"}>{stage.label}</span>
      </div>
      {epoch === null ? (
        <p className="mkts-quiet">Its first week hasn&apos;t opened yet.</p>
      ) : (
        <div className="mkts-market-body">
          <dl className="mkts-facts">
            <div className="mkts-fact">
              <dt>{referenceLabel(epoch)}</dt>
              <dd>
                <span className="mkts-figure num">{dollars(epoch.referencePrice)}</span>
                <span className="mkts-sub">{easternTime(epoch.opening)}</span>
              </dd>
            </div>
            <div className="mkts-fact">
              <dt>Week</dt>
              <dd>{span(epoch.opening, epoch.expiry)}</dd>
            </div>
          </dl>
          <section className="mkts-rates-block" aria-label={`${market.symbol} rates`}>
            <p className="mkts-rates-title">
              Rates per {market.symbol}
              {maker !== null && rows.some((r) => r.rate?.source === "maker") && (
                <span className="mkts-sub">
                  The maker&apos;s bids computed {easternTime(maker.computedAt)}
                </span>
              )}
            </p>
            <RateRows rows={nearest} symbol={market.symbol} />
          </section>
        </div>
      )}
      <Link className="ov-link mkts-open" to={withAsset("/trade", market.symbol)}>
        Open the rate sheet
      </Link>
    </article>
  );
}

// One token the market check covered and the build doesn't list: how many checks it passed, and
// each one it didn't, by name. The file's own reasons are diagnostics for whoever lists markets,
// so they stay out of the page.
function OtherToken({ token }: { readonly token: CheckedToken }) {
  const passes = token.checks.filter((c) => c.status === "pass").length;
  const open = token.checks.filter((c) => c.status !== "pass");
  return (
    <li className="mkts-other">
      <div className="mkts-other-head">
        <TokenLogo symbol={token.symbol} size="md" />
        <div className="mkts-market-name">
          <p className="mkts-other-symbol">{token.symbol}</p>
          <p className="mkts-sub">{token.name}</p>
        </div>
      </div>
      <div className="mkts-other-state">
        <span className="mkts-sub num">
          {passes} of {token.checks.length} checks passed
        </span>
        <span className="chip chip-plain">Not listed yet</span>
      </div>
      <ul className="mkts-checks" aria-label={`${token.symbol}'s checks`}>
        {open.length === 0 ? (
          <li className="chip">Passed every check</li>
        ) : (
          open.map((check) => (
            <li key={check.key} className={CHIP_TONES[check.status]}>
              {labelOf(check.key)} {STATUS_LABELS[check.status]}
            </li>
          ))
        )}
      </ul>
    </li>
  );
}

function Others({
  check,
  tokens,
}: {
  readonly check: MarketCheck;
  readonly tokens: readonly CheckedToken[];
}) {
  const [all, setAll] = useState(false);
  const when = check.generatedAt ?? check.block?.timestamp ?? null;
  const shown = all ? tokens : tokens.slice(0, OTHERS_SHOWN);
  return (
    <>
      <p className="mkts-note">
        From the market check
        {check.block === null ? "" : ` at block ${check.block.number.toLocaleString("en-US")}`}
        {when === null ? "" : `, ${easternTime(when)}`}.
      </p>
      {tokens.length === 0 ? (
        <p className="empty-state">Every Stock Token the market check covered is live.</p>
      ) : (
        <ul className="mkts-others">
          {shown.map((token) => (
            <OtherToken key={token.address} token={token} />
          ))}
        </ul>
      )}
      {!all && tokens.length > OTHERS_SHOWN && (
        <div className="mkts-more">
          <p className="mkts-sub num">
            Showing {OTHERS_SHOWN} of {tokens.length}
          </p>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              setAll(true);
            }}
          >
            Show all
          </button>
        </div>
      )}
    </>
  );
}

// What the card says while there's no market check to list.
function checkMissing(state: Exclude<MarketCheckState, { readonly status: "ready" }>): string {
  switch (state.status) {
    case "loading":
      return "Reading the market check.";
    case "missing":
      return "The market check isn't published yet, so only the live markets show here.";
    case "failed":
      return `The market check couldn't be loaded: ${state.reason}`;
  }
}

export function MarketsPage(): ReactNode {
  const { config, view } = useApp();
  const checkState = useMarketCheck(config.chainId);
  if (view === null) return null;
  const check = checkState.status === "ready" ? checkState.check : null;
  const others = check === null ? [] : notListed(check, config.markets);
  const nameOf = (asset: AssetView): string | null =>
    check?.tokens.find((t) => t.address === asset.market.token)?.name ?? null;
  return (
    <>
      <section className="mkts-live" aria-labelledby="mkts-live-title">
        <div className="mkts-head">
          <h2 id="mkts-live-title" className="h3">
            Live now
          </h2>
          <span className="card-count num">
            {view.assets.length}
            <span className="visually-hidden"> markets</span>
          </span>
        </div>
        <div className="mkts-grid">
          {view.assets.map((asset) => (
            <LiveMarket
              key={asset.market.token}
              asset={asset}
              name={nameOf(asset)}
              now={view.now}
            />
          ))}
        </div>
      </section>
      <section className="card mkts-card" aria-labelledby="mkts-others-title">
        <div className="card-head">
          <div>
            <h2 id="mkts-others-title" className="h3">
              Not listed yet
            </h2>
            <p className="card-sub">
              Every other Stock Token, with what the market check found. More Stock Tokens list as
              they pass the market check.
            </p>
          </div>
        </div>
        {checkState.status === "ready" ? (
          <Others check={checkState.check} tokens={others} />
        ) : (
          <p className="empty-state">{checkMissing(checkState)}</p>
        )}
      </section>
    </>
  );
}
