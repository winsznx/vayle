import { TokenIcon } from "../../ui/TokenIcon.tsx";
import type { AppConfig } from "../config.ts";
import { dollars, easternClock, easternTime, feedDollars } from "../format.ts";
import type { MarketView } from "../useMarket.ts";
import { BID_WINDOW, bidOpensAt, type Epoch } from "../week.ts";

const STAGES = ["Close", "Bids", "Batch", "Week", "Next close"] as const;

// Where the week stands, by the same clock the contracts keep.
function stageOf(e: Epoch, now: number): number {
  const bidOpen = bidOpensAt(e);
  if (now < bidOpen) return 0;
  if (now < bidOpen + BID_WINDOW) return 1;
  if (now < e.batchDeadline) return 2;
  if (now < e.expiry) return 3;
  return 4;
}

function stageNote(e: Epoch, now: number): string {
  const bidOpen = bidOpensAt(e);
  switch (stageOf(e, now)) {
    case 0:
      return `Bids open at ${easternClock(bidOpen)}`;
    case 1:
      return `Taking bids until ${easternClock(bidOpen + BID_WINDOW)}`;
    case 2:
      return `Batch window until ${easternTime(e.batchDeadline)}`;
    case 3:
      return `Ends ${easternTime(e.expiry)}`;
    default:
      return "This week has ended";
  }
}

export function WeekCard({
  config,
  view,
}: {
  readonly config: AppConfig;
  readonly view: MarketView;
}) {
  const e = view.epoch;
  if (e === null) {
    return (
      <article className="card stat stat-week">
        <div className="stat-head">
          <TokenIcon symbol="NVDA" size="lg" />
          <div>
            <p className="stat-title">{config.assetSymbol}</p>
            <p className="stat-note">The first week opens at the next weekly close</p>
          </div>
        </div>
        <p className="figure num">{feedDollars(view.feedAnswer, view.feedDecimals)}</p>
        <p className="stat-caption">Latest feed price</p>
      </article>
    );
  }
  const stage = stageOf(e, view.now);
  return (
    <article className="card stat stat-week">
      <div className="stat-head">
        <TokenIcon symbol="NVDA" size="lg" />
        <div>
          <p className="stat-title">{config.assetSymbol}</p>
          <p className="stat-note">{stageNote(e, view.now)}</p>
        </div>
      </div>
      <p className="figure num">{dollars(e.referencePrice)}</p>
      <p className="stat-caption">Close on {easternTime(e.opening)}</p>
      <ol className="stage-track" aria-label="Where this week stands">
        {STAGES.map((label, i) => (
          <li
            key={label}
            className={i === stage ? "is-current" : i < stage ? "is-past" : undefined}
            aria-current={i === stage ? "step" : undefined}
          >
            <span className="stage-label">{label}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}
