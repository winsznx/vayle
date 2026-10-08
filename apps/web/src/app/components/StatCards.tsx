import type { CSSProperties } from "react";
import { TickerBadge } from "../../ui/TickerBadge.tsx";
import { dollars, easternClock, easternTime, feedDollars } from "../format.ts";
import type { AssetView } from "../useMarket.ts";
import {
  BID_WINDOW,
  bidOpensAt,
  hasBatch,
  progressOf,
  stagesOf,
  type Epoch,
  type StageKey,
} from "../week.ts";

const LABELS: Readonly<Record<StageKey, string>> = {
  close: "Close",
  bids: "Bids",
  batch: "Batch",
  week: "Week",
  "next-close": "Next close",
  quotes: "Quotes",
  window: "Close",
  "window-end": "Window ends",
};

// Where the week stands, by the same clock the contracts keep.
function stageNote(e: Epoch, now: number): string {
  if (!hasBatch(e)) {
    const windowEnds = e.expiry + e.windowLength;
    if (now < e.expiry) return `Fills by quote until ${easternTime(e.expiry)}`;
    if (now < windowEnds) return `Exercise window until ${easternClock(windowEnds)}`;
    return "This week has ended";
  }
  const bidOpen = bidOpensAt(e);
  if (now < bidOpen) return `Bids open at ${easternClock(bidOpen)}`;
  if (now < bidOpen + BID_WINDOW) return `Taking bids until ${easternClock(bidOpen + BID_WINDOW)}`;
  if (now < e.batchDeadline) return `Batch window until ${easternTime(e.batchDeadline)}`;
  if (now < e.expiry) return `Ends ${easternTime(e.expiry)}`;
  return "This week has ended";
}

export function WeekCard({ asset, now }: { readonly asset: AssetView; readonly now: number }) {
  const e = asset.epoch;
  const symbol = asset.market.symbol;
  if (e === null) {
    return (
      <article className="card stat stat-week">
        <div className="stat-head">
          <TickerBadge symbol={symbol} size="lg" />
          <div>
            <p className="stat-title">{symbol}</p>
            <p className="stat-note">Its first week hasn&apos;t opened yet</p>
          </div>
        </div>
        <p className="figure num">{feedDollars(asset.feedAnswer, asset.feedDecimals)}</p>
        <p className="stat-caption">Latest feed price</p>
      </article>
    );
  }
  const stages = stagesOf(e);
  const { index } = progressOf(stages, now);
  const count = { "--stages": stages.length } as CSSProperties;
  return (
    <article className="card stat stat-week">
      <div className="stat-head">
        <TickerBadge symbol={symbol} size="lg" />
        <div>
          <p className="stat-title">{symbol}</p>
          <p className="stat-note">{stageNote(e, now)}</p>
        </div>
      </div>
      <p className="figure num">{dollars(e.referencePrice)}</p>
      <p className="stat-caption">
        {hasBatch(e) ? "Close on" : "Opened"} {easternTime(e.opening)}
      </p>
      <ol className="stage-track" style={count} aria-label="Where this week stands">
        {stages.map((stage, i) => (
          <li
            key={stage.key}
            className={i === index ? "is-current" : i < index ? "is-past" : undefined}
            aria-current={i === index ? "step" : undefined}
          >
            <span className="stage-label">{LABELS[stage.key]}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}
