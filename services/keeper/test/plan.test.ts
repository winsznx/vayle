import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHUNK,
  KEEPER_LEAD,
  plan,
  type Action,
  type BucketView,
  type OrderView,
  type Snapshot,
} from "../src/plan.ts";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
// The Fri Oct 2 16:00 ET close, the Monday 09:30 ET after it, and the Oct 9 close.
const OCT_02 = 1_790_971_200;
const OCT_05_OPEN = 1_791_207_000;
const OCT_09 = 1_791_576_000;
const DEADLINE = OCT_05_OPEN - 13 * 3600 - 30 * 60;
const BID_CLOSE = OCT_02 + 4 * 3600;
// Wednesday Oct 7, mid-week.
const WEDNESDAY = 1_791_374_400;
const SERIES = 77n;
const TARGET = 240_000_000n;

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    now: WEDNESDAY,
    asset: NVDA,
    lookback: 1800,
    bidWindow: 7200,
    latestBoundary: { close: OCT_02, creationDeadline: OCT_05_OPEN },
    nextClose: OCT_09,
    epoch: { opening: OCT_02, expiry: OCT_09, batchDeadline: DEADLINE, windowLength: 7200 },
    epochAtLatest: true,
    roundHint: null,
    series: [],
    orders: null,
    buckets: [],
    ...overrides,
  };
}

function order(id: bigint, overrides: Partial<OrderView> = {}): OrderView {
  return {
    id,
    side: 0,
    target: TARGET,
    status: "active",
    series: 0n,
    minPremium: 0n,
    ...overrides,
  };
}

function bucket(overrides: Partial<BucketView> = {}): BucketView {
  return {
    series: SERIES,
    side: 0,
    target: TARGET,
    bidPremium: 2_500_000n,
    phase: "none",
    cursor: 0n,
    maxOrderId: 0n,
    attached: 0n,
    ...overrides,
  };
}

function kinds(actions: readonly Action[]): string[] {
  return actions.map((a) => a.kind);
}

describe("plan", () => {
  it("does nothing mid-week", () => {
    // #when
    const actions = plan(snapshot());
    // #then
    assert.deepEqual(actions, []);
  });

  it("pings from 45 minutes before a close", () => {
    // #when
    const actions = plan(snapshot({ now: OCT_09 - KEEPER_LEAD }));
    // #then
    assert.deepEqual(kinds(actions), ["checkpoint"]);
  });

  it("observes the oracle in the last 30 minutes before a close", () => {
    // #when
    const actions = plan(snapshot({ now: OCT_09 - 60 }));
    // #then
    assert.deepEqual(actions, [{ kind: "observeClose", asset: NVDA }]);
  });

  it("creates the epoch after the close and keeps pinging through the window", () => {
    // #given
    const s = snapshot({ now: OCT_02 + 600, epochAtLatest: false, roundHint: 99n });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(kinds(actions), ["checkpoint", "observePauses", "createEpoch"]);
  });

  it("stops trying to create an epoch at its deadline", () => {
    // #given
    const s = snapshot({ now: OCT_05_OPEN, epochAtLatest: false, roundHint: 99n });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, []);
  });

  it("keeps pinging while an extended window is still open", () => {
    // #given
    const s = snapshot({
      now: OCT_02 + 5 * 3600,
      orders: [],
      series: [{ id: 5n, expiry: OCT_02, windowEnd: OCT_02 + 6 * 3600, settled: false }],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(kinds(actions), ["checkpoint", "observePauses"]);
  });

  it("finalizes a series once its window has ended, then settles its orders", () => {
    // #given
    const s = snapshot({
      now: OCT_02 + 3 * 3600,
      orders: [order(1n, { series: 5n }), order(2n, { series: 6n })],
      series: [
        { id: 5n, expiry: OCT_02, windowEnd: OCT_02 + 7200, settled: false },
        { id: 6n, expiry: OCT_02, windowEnd: OCT_02 + 7200, settled: true },
      ],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "finalize" || a.kind === "settleOrder");
    // #then
    assert.deepEqual(actions, [
      { kind: "finalize", series: 5n },
      { kind: "settleOrder", id: 2n },
    ]);
  });

  it("opens a batch once the bid window has run", () => {
    // #given
    const s = snapshot({ now: BID_CLOSE, orders: [order(1n)], buckets: [bucket()] });
    // #when
    const actions = plan(s).filter((a) => a.kind === "openBatch");
    // #then
    assert.deepEqual(actions, [{ kind: "openBatch", series: SERIES }]);
  });

  it("waits for last week's orders before opening a batch", () => {
    // #given
    const s = snapshot({
      now: BID_CLOSE,
      orders: [order(1n)],
      buckets: [bucket({ attached: 1n })],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "openBatch");
    // #then
    assert.deepEqual(actions, []);
  });

  it("leaves a bucket with no bid alone", () => {
    // #given
    const s = snapshot({
      now: BID_CLOSE,
      orders: [order(1n)],
      buckets: [bucket({ bidPremium: null })],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "openBatch");
    // #then
    assert.deepEqual(actions, []);
  });

  it("counts the bucket's idle orders after the cursor, in chunks, in order", () => {
    // #given: 250 idle orders listed out of order, 3 already counted
    const orders = Array.from({ length: 250 }, (_, i) => order(BigInt(250 - i)));
    const s = snapshot({
      now: BID_CLOSE,
      orders,
      buckets: [bucket({ phase: "counting", cursor: 3n, maxOrderId: 250n })],
    });
    // #when
    const count = plan(s).find((a) => a.kind === "countBatch");
    // #then
    assert.deepEqual(count, {
      kind: "countBatch",
      series: SERIES,
      ids: Array.from({ length: CHUNK }, (_, i) => BigInt(i + 4)),
    });
  });

  it("fills only orders whose minimum the bid meets", () => {
    // #given
    const orders = [order(1n), order(2n, { minPremium: 9_000_000n }), order(3n)];
    const s = snapshot({
      now: BID_CLOSE,
      orders,
      buckets: [bucket({ phase: "filling", maxOrderId: 3n })],
    });
    // #when
    const fill = plan(s).find((a) => a.kind === "fillBatch");
    // #then
    assert.deepEqual(fill, { kind: "fillBatch", series: SERIES, ids: [1n, 3n] });
  });

  it("closes a batch that is still filling when its series expires", () => {
    // #given
    const s = snapshot({
      now: OCT_09,
      nextClose: OCT_09 + 7 * 86_400,
      orders: [order(1n)],
      buckets: [bucket({ phase: "filling", maxOrderId: 1n })],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "closeBatch");
    // #then
    assert.deepEqual(actions, [{ kind: "closeBatch", series: SERIES }]);
  });

  it("stops counting at the deadline", () => {
    // #given
    const s = snapshot({
      now: DEADLINE,
      orders: [order(1n)],
      buckets: [bucket({ phase: "counting", maxOrderId: 1n })],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "countBatch");
    // #then
    assert.deepEqual(actions, []);
  });
});
