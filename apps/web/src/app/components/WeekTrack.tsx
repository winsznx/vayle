import type { CSSProperties } from "react";
import { easternTime } from "../format.ts";
import { progressOf, stagesOf, type Epoch, type StageKey } from "../week.ts";
import "./dashboard.css";

// The week by the times the market recorded for it. Each stage says what happens in it, the
// current one is marked, and the line fills as the chain's clock moves. A week without a batch is
// one stretch of fills by quote to the close, then the exercise window.

const STAGES: Readonly<Record<StageKey, { readonly label: string; readonly note: string }>> = {
  close: {
    label: "Close",
    note: "The week's prices come from the close, and last week's targets settle.",
  },
  bids: { label: "Bids", note: "The maker bids for each price." },
  batch: {
    label: "Batch",
    note: "Targets are written into the week at the best bid, and you're paid.",
  },
  week: {
    label: "Week",
    note: "Targets hold through the week. At the next close each fills at its price or renews.",
  },
  "next-close": { label: "Next close", note: "The next week starts from this close." },
  quotes: {
    label: "Fills by quote",
    note: "From the opening to the close, a target fills when the maker quotes it.",
  },
  window: { label: "Close", note: "The exercise window opens at the close." },
  "window-end": {
    label: "Window ends",
    note: "The week settles, and targets that didn't fill renew into the next one.",
  },
};

export function WeekTrack({ epoch, now }: { readonly epoch: Epoch | null; readonly now: number }) {
  if (epoch === null) {
    return (
      <section className="card week-track week-track-empty">
        <h2 className="h3">This week</h2>
        <p className="muted">The first week opens at the next weekly close.</p>
      </section>
    );
  }
  const stages = stagesOf(epoch);
  const { index, fill } = progressOf(stages, now);
  const count = { "--stages": stages.length } as CSSProperties;
  return (
    <section className="card week-track" aria-label="Where this week stands">
      <div className="week-track-head">
        <h2 className="h3">This week</h2>
        <p className="card-sub">
          {easternTime(epoch.opening)} to {easternTime(epoch.expiry)}
        </p>
      </div>
      <div className="week-track-body" style={count}>
        <div className="week-track-line" aria-hidden="true">
          <span className="week-track-fill" style={{ width: `${fill * 100}%` }} />
        </div>
        <ol className="week-track-stages">
          {stages.map((stage, i) => (
            <li
              key={stage.key}
              className={i === index ? "is-current" : i < index ? "is-past" : undefined}
              aria-current={i === index ? "step" : undefined}
            >
              <span className="week-track-dot" aria-hidden="true" />
              <span className="week-track-label">{STAGES[stage.key].label}</span>
              <time className="week-track-time" dateTime={new Date(stage.at * 1000).toISOString()}>
                {easternTime(stage.at)}
              </time>
              <span className="week-track-note">{STAGES[stage.key].note}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
