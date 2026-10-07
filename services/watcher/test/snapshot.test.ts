import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOUNDARY_WINDOW,
  walkBoundaries,
  type Boundary,
  type CalendarPosition,
} from "../src/snapshot.ts";
import { OCT_02 } from "./fixtures.ts";

const WEEK = 7 * 86_400;
// The Monday 09:30 ET after a Friday 16:00 ET close.
const DEADLINE_AFTER = 2 * 86_400 + 17 * 3_600 + 30 * 60;

// `count` weekly boundaries from the Oct 2 close.
function calendar(count: number): Boundary[] {
  return Array.from({ length: count }, (_, i) => ({
    close: OCT_02 + i * WEEK,
    creationDeadline: OCT_02 + i * WEEK + DEADLINE_AFTER,
  }));
}

function reader(boundaries: readonly Boundary[]): {
  read: (indexes: readonly bigint[]) => Promise<readonly Boundary[]>;
  calls: bigint[][];
} {
  const calls: bigint[][] = [];
  return {
    read: (indexes) => {
      calls.push([...indexes]);
      return Promise.resolve(
        indexes.map((i) => {
          const b = boundaries[Number(i)];
          if (b === undefined) throw new RangeError(`no boundary at ${i}`);
          return b;
        }),
      );
    },
    calls,
  };
}

// The walk as it ran before windows: one boundary at a time from the last.
function oneAtATime(boundaries: readonly Boundary[], now: number): CalendarPosition {
  let boundariesAhead = 0;
  let nextClose: number | null = null;
  for (let index = boundaries.length; index > 0; index--) {
    const b = boundaries[index - 1];
    if (b === undefined) break;
    if (b.close > now) {
      boundariesAhead++;
      nextClose = b.close;
      continue;
    }
    return { latestBoundary: b, nextClose, boundariesAhead };
  }
  return { latestBoundary: null, nextClose, boundariesAhead };
}

describe("walkBoundaries", () => {
  it("places now where the one-at-a-time walk did, on, before and after every close", async () => {
    // #given: calendars shorter and longer than a window, at every close and a second either side
    const windowed: CalendarPosition[] = [];
    const walked: CalendarPosition[] = [];
    // #when
    for (const count of [0, 1, 10, BOUNDARY_WINDOW, BOUNDARY_WINDOW + 1, 150]) {
      const boundaries = calendar(count);
      const times = [0, OCT_02 + count * WEEK];
      for (const b of boundaries) times.push(b.close - 1, b.close, b.close + 1);
      for (const now of times) {
        windowed.push(await walkBoundaries(BigInt(count), now, reader(boundaries).read));
        walked.push(oneAtATime(boundaries, now));
      }
    }
    // #then
    assert.deepEqual(windowed, walked);
  });

  it("reads the calendar in one call when the latest close is among its last 64", async () => {
    // #given: 150 boundaries, now on the close 64 from the end
    const boundaries = calendar(150);
    const { read, calls } = reader(boundaries);
    const now = boundaries[150 - BOUNDARY_WINDOW]?.close ?? 0;
    // #when
    const position = await walkBoundaries(150n, now, read);
    // #then
    assert.deepEqual([position.boundariesAhead, calls.length], [BOUNDARY_WINDOW - 1, 1]);
  });

  it("counts every boundary ahead when more are scheduled than one call reads", async () => {
    // #given: 150 boundaries, all ahead of now
    const { read, calls } = reader(calendar(150));
    // #when
    const position = await walkBoundaries(150n, OCT_02 - 1, read);
    // #then
    assert.deepEqual(
      [position.latestBoundary, position.boundariesAhead, position.nextClose, calls.length],
      [null, 150, OCT_02, 3],
    );
  });

  it("reads nothing from an empty calendar", async () => {
    // #given
    const { read, calls } = reader([]);
    // #when
    const position = await walkBoundaries(0n, OCT_02, read);
    // #then
    assert.deepEqual(
      [position, calls.length],
      [{ latestBoundary: null, nextClose: null, boundariesAhead: 0 }, 0],
    );
  });
});
