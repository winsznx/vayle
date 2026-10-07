import { easternTime } from "../format.ts";
import { BID_WINDOW, bidOpensAt, type Epoch } from "../week.ts";
import "./dashboard.css";

// The week from one close to the next, by the times the market recorded for it. Each stage says
// what happens in it, the current one is marked, and the line fills as the chain's clock moves.

interface Stage {
  readonly label: string;
  readonly at: number;
  readonly note: string;
}

function stagesOf(e: Epoch): Stage[] {
  const bidOpen = bidOpensAt(e);
  return [
    {
      label: "Close",
      at: e.opening,
      note: "The week's prices come from the close, and last week's options can be exercised.",
    },
    {
      label: "Bids",
      at: bidOpen,
      note: "The team-operated maker bids for each price.",
    },
    {
      label: "Batch",
      at: bidOpen + BID_WINDOW,
      note: "Orders are written into the week at the best bid, and their premium is paid.",
    },
    {
      label: "Week",
      at: e.batchDeadline,
      note: "Orders hold through the week. At the next close each fills at its price or renews.",
    },
    { label: "Next close", at: e.expiry, note: "The next week starts from this close." },
  ];
}

// How far along the track the clock is, from 0 at the close to 1 at the next close. The stages are
// drawn evenly, so progress runs evenly within the current one.
function progressOf(stages: readonly Stage[], now: number): { index: number; fill: number } {
  let index = 0;
  stages.forEach((s, i) => {
    if (now >= s.at) index = i;
  });
  const from = stages[index];
  const to = stages[index + 1];
  if (from === undefined || to === undefined) return { index, fill: 1 };
  const within = Math.min(1, Math.max(0, (now - from.at) / (to.at - from.at)));
  return { index, fill: (index + within) / (stages.length - 1) };
}

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
  return (
    <section className="card week-track" aria-label="Where this week stands">
      <div className="week-track-head">
        <h2 className="h3">This week</h2>
        <p className="card-sub">
          {easternTime(epoch.opening)} to {easternTime(epoch.expiry)}
        </p>
      </div>
      <div className="week-track-body">
        <div className="week-track-line" aria-hidden="true">
          <span className="week-track-fill" style={{ width: `${fill * 100}%` }} />
        </div>
        <ol className="week-track-stages">
          {stages.map((stage, i) => (
            <li
              key={stage.label}
              className={i === index ? "is-current" : i < index ? "is-past" : undefined}
              aria-current={i === index ? "step" : undefined}
            >
              <span className="week-track-dot" aria-hidden="true" />
              <span className="week-track-label">{stage.label}</span>
              <time className="week-track-time" dateTime={new Date(stage.at * 1000).toISOString()}>
                {easternTime(stage.at)}
              </time>
              <span className="week-track-note">{stage.note}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
