import type { Session, Window } from "./sessions.ts";

// How fresh a feed kept itself over the lookback, from the update times of the rounds it
// published. A gap is the time inside a set of windows between one update and the next, so a
// stretch that runs over a night or a weekend counts only the hours the windows cover. The stretch
// before the first update in the lookback counts from the lookback's start, and the stretch after
// the last one runs to the pinned block's time.

export interface StalenessFigures {
  readonly maxRegularHoursGapSeconds: number;
  readonly maxMarketHoursGapSeconds: number;
  // Seconds from each lookback close back to the last update at or before it, oldest close first.
  // Null where no round was published at or before that close.
  readonly agesAtClose: readonly (number | null)[];
}

export interface StalenessRule {
  readonly heartbeatSeconds: number;
  readonly maxAgeAtCloseSeconds: number;
}

// Seconds of `windows` inside the interval from `from` to `to`.
export function overlap(from: number, to: number, windows: readonly Window[]): number {
  let total = 0;
  for (const w of windows) {
    const start = Math.max(from, w.start);
    const end = Math.min(to, w.end);
    if (end > start) total += end - start;
  }
  return total;
}

// The longest time inside `windows` between consecutive updates from `start` to `end`.
// `updates` must be sorted ascending.
export function longestGap(
  updates: readonly number[],
  windows: readonly Window[],
  start: number,
  end: number,
): number {
  let longest = 0;
  let previous = start;
  for (const t of updates) {
    if (t <= start) continue;
    if (t >= end) break;
    longest = Math.max(longest, overlap(previous, t, windows));
    previous = t;
  }
  return Math.max(longest, overlap(previous, end, windows));
}

// The last update at or before `at` in sorted `updates`, or null.
export function lastAtOrBefore(updates: readonly number[], at: number): number | null {
  let lo = 0;
  let hi = updates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((updates[mid] ?? Infinity) <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : (updates[lo - 1] ?? null);
}

// `sessions` is the lookback, oldest first, and `now` the pinned block's time.
export function stalenessFigures(
  updates: readonly number[],
  sessions: readonly Session[],
  now: number,
): StalenessFigures {
  const first = sessions[0];
  if (first === undefined) throw new RangeError("the lookback has no sessions");
  const sorted = [...updates].sort((a, b) => a - b);
  return {
    maxRegularHoursGapSeconds: longestGap(
      sorted,
      sessions.map((s) => s.regular),
      first.regular.start,
      now,
    ),
    maxMarketHoursGapSeconds: longestGap(
      sorted,
      sessions.map((s) => s.feed),
      first.feed.start,
      now,
    ),
    agesAtClose: sessions.map((s) => {
      const last = lastAtOrBefore(sorted, s.regular.end);
      return last === null ? null : s.regular.end - last;
    }),
  };
}

// Pass when no market-hours gap is longer than the feed's published heartbeat and every lookback
// close had a round no older than the limit. The reason names the first rule broken.
export function judgeStaleness(
  figures: StalenessFigures,
  closes: readonly number[],
  rule: StalenessRule,
): { readonly pass: boolean; readonly reason: string } {
  for (const [i, age] of figures.agesAtClose.entries()) {
    const close = new Date((closes[i] ?? 0) * 1000).toISOString();
    if (age === null) return { pass: false, reason: `no round at or before the ${close} close` };
    if (age > rule.maxAgeAtCloseSeconds) {
      return {
        pass: false,
        reason: `the round at the ${close} close was ${age} s old, over ${rule.maxAgeAtCloseSeconds} s`,
      };
    }
  }
  if (figures.maxMarketHoursGapSeconds > rule.heartbeatSeconds) {
    return {
      pass: false,
      reason: `${figures.maxMarketHoursGapSeconds} s of market hours passed without an update, over the ${rule.heartbeatSeconds} s heartbeat`,
    };
  }
  return { pass: true, reason: "" };
}
