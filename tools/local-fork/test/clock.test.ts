import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceTarget,
  AFTER_FIRST_WEEK,
  DENSE_BEFORE_CLOSE,
  DENSE_STEP,
  FEED_LEAD,
  nextTick,
  NothingToAdvanceTo,
  SPARSE_STEP,
  type Week,
} from "../src/clock.ts";

// Fri Oct 9 2026 16:00 EDT and the Friday after.
const CLOSE = 1_791_576_000;
const NEXT_CLOSE = CLOSE + 7 * 86_400;
const HOUR = 3600;
const WEEK: Week = {
  opening: CLOSE,
  expiry: NEXT_CLOSE,
  windowLength: 2 * HOUR,
  batchDeadline: CLOSE + 2 * 86_400 + 4 * HOUR,
};
const BID_WINDOW = 2 * HOUR;

function ticks(from: number, to: number, closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let t = nextTick(from, closes); t <= to; t = nextTick(t, closes)) out.push(t);
  return out;
}

describe("nextTick", () => {
  it("takes large steps far from any close", () => {
    // #given
    const t = CLOSE - 2 * 86_400;
    // #when
    const next = nextTick(t, [CLOSE]);
    // #then
    assert.equal(next, t + SPARSE_STEP);
  });

  it("stops at the start of the stretch before a close instead of stepping over it", () => {
    // #given
    const t = CLOSE - DENSE_BEFORE_CLOSE - 60;
    // #when
    const next = nextTick(t, [CLOSE]);
    // #then
    assert.equal(next, CLOSE - DENSE_BEFORE_CLOSE);
  });

  it("takes small steps near a close", () => {
    // #given
    const t = CLOSE - 20 * 60;
    // #when
    const next = nextTick(t, [CLOSE]);
    // #then
    assert.equal(next, t + DENSE_STEP);
  });

  it("lands exactly on the close's feed time", () => {
    // #given
    const t = CLOSE - FEED_LEAD - 60;
    // #when
    const next = nextTick(t, [CLOSE]);
    // #then
    assert.equal(next, CLOSE - FEED_LEAD);
  });

  it("leaves no stretch of 5 minutes without a tick from 45 minutes before a close to 4 hours after", () => {
    // #given
    const all = ticks(CLOSE - 86_400, CLOSE + 5 * HOUR, [CLOSE]);
    const near = all.filter((t) => t >= CLOSE - 45 * 60 && t <= CLOSE + 4 * HOUR);
    // #when
    const widest = Math.max(...near.slice(1).map((t, i) => t - (near[i] ?? t)));
    // #then
    assert.ok(widest < 5 * 60, `widest gap ${widest} s`);
  });

  it("keeps ticks dense until the deploy's liveness record covers the lookback", () => {
    // #given: a deploy two days before the first close
    const deployedAt = CLOSE - 2 * 86_400;
    const denseUntil = deployedAt + 45 * 60;
    // #when
    const next = nextTick(deployedAt + 10 * 60, [CLOSE], denseUntil);
    const after = nextTick(denseUntil, [CLOSE], denseUntil);
    // #then
    assert.deepEqual(
      [next - (deployedAt + 10 * 60), after - denseUntil],
      [DENSE_STEP, SPARSE_STEP],
    );
  });

  it("ticks in the last 5 minutes before a close, where the close is observed", () => {
    // #given
    const all = ticks(CLOSE - 86_400, CLOSE + HOUR, [CLOSE]);
    // #when
    const inLastFive = all.filter((t) => t >= CLOSE - 5 * 60 && t <= CLOSE);
    // #then
    assert.ok(inLastFive.length > 0);
  });
});

describe("advanceTarget", () => {
  it("opens the first week once the deploy's liveness record covers the lookback", () => {
    // #given
    const deployedAt = CLOSE - 2 * 86_400;
    const firstWeekAt = deployedAt + 30 * 60;
    // #when
    const target = advanceTarget(deployedAt + 60, null, CLOSE, BID_WINDOW, firstWeekAt);
    // #then
    assert.deepEqual(target, { at: firstWeekAt + AFTER_FIRST_WEEK, what: "the first week opens" });
  });

  it("runs a first week, which has no batch, straight to its close and window", () => {
    // #given: a first week opened mid-week, its batch deadline at its opening
    const opening = CLOSE - 2 * 86_400;
    const first: Week = { opening, expiry: CLOSE, windowLength: 2 * HOUR, batchDeadline: opening };
    // #when
    const target = advanceTarget(opening + HOUR, first, CLOSE, BID_WINDOW);
    // #then
    assert.equal(target.at, CLOSE + 2 * HOUR + 20 * 60);
  });

  it("opens the first week at the next close when there's none", () => {
    // #given
    const now = CLOSE - 2 * 86_400;
    // #when
    const target = advanceTarget(now, null, CLOSE, BID_WINDOW);
    // #then
    assert.deepEqual(target, { at: CLOSE + 5 * 60, what: "the first week opens" });
  });

  it("goes far enough into the bid window for the maker to register and then bid", () => {
    // #given
    const now = CLOSE + 10 * 60;
    // #when
    const target = advanceTarget(now, WEEK, NEXT_CLOSE, BID_WINDOW);
    // #then
    const bidOpen = CLOSE + 2 * HOUR;
    const ticksInWindow = ticks(now, target.at, [CLOSE]).filter((t) => t >= bidOpen);
    assert.ok(ticksInWindow.length >= 2, `${ticksInWindow.length} ticks`);
  });

  it("goes past the bid window so the batch fills", () => {
    // #given
    const now = CLOSE + 2 * HOUR + 5 * 60;
    // #when
    const target = advanceTarget(now, WEEK, NEXT_CLOSE, BID_WINDOW);
    // #then
    assert.equal(target.at, CLOSE + 4 * HOUR + 20 * 60);
  });

  it("goes through the expiry's exercise window once the batch is over", () => {
    // #given
    const now = CLOSE + 4 * HOUR + 20 * 60;
    // #when
    const target = advanceTarget(now, WEEK, NEXT_CLOSE, BID_WINDOW);
    // #then
    assert.equal(target.at, NEXT_CLOSE + 2 * HOUR + 20 * 60);
  });

  it("goes to the next close when the latest week ended and none followed", () => {
    // #given
    const now = NEXT_CLOSE + 3 * HOUR;
    const following = NEXT_CLOSE + 7 * 86_400;
    // #when
    const target = advanceTarget(now, WEEK, following, BID_WINDOW);
    // #then
    assert.deepEqual(target, { at: following + 5 * 60, what: "the next week opens" });
  });

  it("refuses when the calendar has no close left", () => {
    // #given
    const now = NEXT_CLOSE + 3 * HOUR;
    // #when
    const attempt = (): unknown => advanceTarget(now, WEEK, null, BID_WINDOW);
    // #then
    assert.throws(attempt, NothingToAdvanceTo);
  });
});
