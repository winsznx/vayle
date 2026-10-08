// How the fork's clock moves. Small steps around each close, where the keeper's pings, the close
// observation, the exercise window and the batch need them, and large steps in between.

export const DENSE_BEFORE_CLOSE = 50 * 60;
export const DENSE_AFTER_CLOSE = 5 * 3600;
// Under the liveness gap threshold of 5 minutes, so no gap is recorded where it matters, and every
// 5-minute stretch holds a tick, so the close is observed in its last 5 minutes.
export const DENSE_STEP = 4 * 60;
export const SPARSE_STEP = 30 * 60;
// Each close's feed round is written at this many seconds before the close, on a tick of its own.
export const FEED_LEAD = 60;

const AFTER_CLOSE = 5 * 60;
// The maker registers a series on one tick and bids on the next, so give it a few.
const AFTER_BIDS_OPEN = 15 * 60;
const AFTER_BATCH = 20 * 60;
// A first week opens once the liveness record covers the lookback after the deploy, and the keeper
// checkpoints every tick until then. A few ticks more leave room for the maker to register series.
export const AFTER_FIRST_WEEK = 5 * 60;

// The tick after t. Never steps over the start of a dense stretch or a feed round's time. Ticks
// stay dense until `denseUntil` too, while the deploy's liveness record has to build up without a gap.
export function nextTick(t: number, closes: readonly number[], denseUntil = 0): number {
  const dense =
    t < denseUntil || closes.some((c) => t >= c - DENSE_BEFORE_CLOSE && t < c + DENSE_AFTER_CLOSE);
  let next = t + (dense ? DENSE_STEP : SPARSE_STEP);
  for (const c of closes) {
    for (const mark of [c - DENSE_BEFORE_CLOSE, c - FEED_LEAD]) {
      if (mark > t && mark < next) next = mark;
    }
  }
  return next;
}

export interface Week {
  readonly opening: number;
  readonly expiry: number;
  readonly windowLength: number;
  // At or before the opening for a first week, which has no renewal batch.
  readonly batchDeadline: number;
}

export interface Target {
  readonly at: number;
  readonly what: string;
}

export class NothingToAdvanceTo extends Error {
  override readonly name = "NothingToAdvanceTo";
}

// Where `pnpm fork advance` goes next, from the latest week and the clock. `firstWeekAt` is when a
// market with no week yet can open its first one, or null once the schedule's first close passed.
export function advanceTarget(
  now: number,
  week: Week | null,
  nextClose: number | null,
  bidWindow: number,
  firstWeekAt: number | null = null,
): Target {
  if (week === null && firstWeekAt !== null) {
    return { at: Math.max(now, firstWeekAt) + AFTER_FIRST_WEEK, what: "the first week opens" };
  }
  if (week !== null && now < week.expiry && week.batchDeadline <= week.opening) {
    return {
      at: week.expiry + week.windowLength + AFTER_BATCH,
      what: "the first week runs to its close, settles and rolls into the next",
    };
  }
  if (week !== null && now < week.expiry) {
    const bidOpen = week.opening + week.windowLength;
    if (now < bidOpen) return { at: bidOpen + AFTER_BIDS_OPEN, what: "the maker bids" };
    if (now < bidOpen + bidWindow) {
      return { at: bidOpen + bidWindow + AFTER_BATCH, what: "the batch fills" };
    }
    return {
      at: week.expiry + week.windowLength + AFTER_BATCH,
      what: "the week ends, settles and rolls into the next",
    };
  }
  if (nextClose === null) {
    throw new NothingToAdvanceTo("the fork's calendar has no close left; run pnpm fork up again");
  }
  return {
    at: nextClose + AFTER_CLOSE,
    what: week === null ? "the first week opens" : "the next week opens",
  };
}

export function minutesTarget(now: number, minutes: number): Target {
  return { at: now + minutes * 60, what: `${minutes} minutes ahead` };
}
