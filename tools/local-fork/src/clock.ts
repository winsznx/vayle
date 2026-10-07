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

// The tick after t. Never steps over the start of a dense stretch or a feed round's time.
export function nextTick(t: number, closes: readonly number[]): number {
  const dense = closes.some((c) => t >= c - DENSE_BEFORE_CLOSE && t < c + DENSE_AFTER_CLOSE);
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
}

export interface Target {
  readonly at: number;
  readonly what: string;
}

export class NothingToAdvanceTo extends Error {
  override readonly name = "NothingToAdvanceTo";
}

// Where `pnpm fork advance` goes next, from the latest week and the clock.
export function advanceTarget(
  now: number,
  week: Week | null,
  nextClose: number | null,
  bidWindow: number,
): Target {
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
