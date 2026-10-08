import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHUNK,
  KEEPER_LEAD,
  plan,
  type Action,
  type BucketView,
  type EpochView,
  type MarketView,
  type OrderView,
  type Snapshot,
} from "../src/plan.ts";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
// A second market's token, for runs over two markets.
const OTHER = "0x00000000000000000000000000000000000000A1";
// The Fri Oct 2 16:00 ET close, the Monday 09:30 ET after it, and the Oct 9 close.
const OCT_02 = 1_790_971_200;
const OCT_05_OPEN = 1_791_207_000;
const OCT_09 = 1_791_576_000;
const DEADLINE = OCT_05_OPEN - 13 * 3600 - 30 * 60;
const BID_CLOSE = OCT_02 + 4 * 3600;
// Wednesday Oct 7, mid-week.
const WEDNESDAY = 1_791_374_400;
// A deploy on Thursday Oct 8 at 10:00 ET, before the schedule's first close on Oct 9.
const DEPLOYED = OCT_09 - 30 * 3600;
const LOOKBACK = 1800;
const SERIES = 77n;
const TARGET = 240_000_000n;

const WEEK: EpochView = {
  opening: OCT_02,
  expiry: OCT_09,
  batchDeadline: DEADLINE,
  windowLength: 7200,
};

function market(overrides: Partial<MarketView> = {}): MarketView {
  return {
    asset: NVDA,
    epoch: WEEK,
    epochAtLatest: true,
    roundHint: null,
    firstHint: null,
    buckets: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    now: WEDNESDAY,
    lookback: LOOKBACK,
    bidWindow: 7200,
    deployedAt: OCT_02 - 7 * 86_400,
    latestBoundary: { close: OCT_02, creationDeadline: OCT_05_OPEN },
    nextClose: OCT_09,
    markets: [market()],
    series: [],
    orders: null,
    ...overrides,
  };
}

// Before the first close: the market deployed on Thursday, no boundary behind, Oct 9 ahead.
function beforeFirstClose(overrides: Partial<Snapshot> = {}): Snapshot {
  return snapshot({
    deployedAt: DEPLOYED,
    latestBoundary: null,
    nextClose: OCT_09,
    markets: [market({ epoch: null, epochAtLatest: false, firstHint: 1188n })],
    ...overrides,
  });
}

function order(id: bigint, overrides: Partial<OrderView> = {}): OrderView {
  return {
    id,
    asset: NVDA,
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

  it("observes every market's oracle before a close", () => {
    // #given
    const s = snapshot({ now: OCT_09 - 60, markets: [market(), market({ asset: OTHER })] });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [
      { kind: "observeClose", asset: NVDA },
      { kind: "observeClose", asset: OTHER },
    ]);
  });

  it("still checkpoints before a close when no market can be acted on", () => {
    // #when
    const actions = plan(snapshot({ now: OCT_09 - 60, markets: [] }));
    // #then
    assert.deepEqual(actions, [{ kind: "checkpoint" }]);
  });

  it("creates the epoch after the close and keeps pinging through the window", () => {
    // #given
    const s = snapshot({
      now: OCT_02 + 600,
      markets: [market({ epochAtLatest: false, roundHint: 99n })],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(kinds(actions), ["checkpoint", "observePauses", "createEpoch"]);
  });

  it("creates each market's epoch with its own round hint, and pings for each", () => {
    // #given
    const s = snapshot({
      now: OCT_02 + 600,
      markets: [
        market({ epochAtLatest: false, roundHint: 99n }),
        market({ asset: OTHER, epochAtLatest: false, roundHint: 77n }),
      ],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [
      { kind: "checkpoint" },
      { kind: "observePauses", asset: NVDA },
      { kind: "observePauses", asset: OTHER },
      { kind: "createEpoch", asset: NVDA, roundHint: 99n },
      { kind: "createEpoch", asset: OTHER, roundHint: 77n },
    ]);
  });

  it("creates no epoch for a market whose week already opened at the close", () => {
    // #given
    const s = snapshot({
      now: OCT_02 + 600,
      markets: [
        market({ epochAtLatest: false, roundHint: 99n }),
        market({ asset: OTHER, epochAtLatest: true }),
      ],
    });
    // #when
    const created = plan(s).filter((a) => a.kind === "createEpoch");
    // #then
    assert.deepEqual(created, [{ kind: "createEpoch", asset: NVDA, roundHint: 99n }]);
  });

  it("stops trying to create an epoch at its deadline", () => {
    // #given
    const s = snapshot({
      now: OCT_05_OPEN,
      markets: [market({ epochAtLatest: false, roundHint: 99n })],
    });
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
    const s = snapshot({
      now: BID_CLOSE,
      orders: [order(1n)],
      markets: [market({ buckets: [bucket()] })],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "openBatch");
    // #then
    assert.deepEqual(actions, [{ kind: "openBatch", series: SERIES }]);
  });

  it("opens a market's batch only for that market's orders", () => {
    // #given: both markets have a bid at the same side and price, and only NVDA has an order there
    const s = snapshot({
      now: BID_CLOSE,
      orders: [order(1n)],
      markets: [
        market({ asset: OTHER, buckets: [bucket({ series: 88n })] }),
        market({ buckets: [bucket()] }),
      ],
    });
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
      markets: [market({ buckets: [bucket({ attached: 1n })] })],
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
      markets: [market({ buckets: [bucket({ bidPremium: null })] })],
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
      markets: [market({ buckets: [bucket({ phase: "counting", cursor: 3n, maxOrderId: 250n })] })],
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
      markets: [market({ buckets: [bucket({ phase: "filling", maxOrderId: 3n })] })],
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
      markets: [market({ buckets: [bucket({ phase: "filling", maxOrderId: 1n })] })],
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
      markets: [market({ buckets: [bucket({ phase: "counting", maxOrderId: 1n })] })],
    });
    // #when
    const actions = plan(s).filter((a) => a.kind === "countBatch");
    // #then
    assert.deepEqual(actions, []);
  });
});

describe("plan before the first close", () => {
  it("checkpoints every run while a market waits for its first week", () => {
    // #given: ten minutes after the deploy, before the lookback after it has passed
    const s = beforeFirstClose({ now: DEPLOYED + 600 });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [{ kind: "checkpoint" }]);
  });

  it("opens each waiting market's first week once a lookback has passed since the deploy", () => {
    // #given
    const s = beforeFirstClose({
      now: DEPLOYED + LOOKBACK,
      markets: [
        market({ epoch: null, epochAtLatest: false, firstHint: 1188n }),
        market({ asset: OTHER, epoch: null, epochAtLatest: false, firstHint: 42n }),
      ],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [
      { kind: "checkpoint" },
      { kind: "createFirstEpoch", asset: NVDA, roundHint: 1188n },
      { kind: "createFirstEpoch", asset: OTHER, roundHint: 42n },
    ]);
  });

  it("opens a first week only for the market still without one", () => {
    // #given: NVDA's first week opened at 10:30 ET, the other market's hasn't
    const first: EpochView = {
      opening: DEPLOYED + LOOKBACK,
      expiry: OCT_09,
      batchDeadline: DEPLOYED + LOOKBACK,
      windowLength: 7200,
    };
    const s = beforeFirstClose({
      now: DEPLOYED + 3 * 3600,
      markets: [
        market({ epoch: first, epochAtLatest: false }),
        market({ asset: OTHER, epoch: null, epochAtLatest: false, firstHint: 42n }),
      ],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [
      { kind: "checkpoint" },
      { kind: "createFirstEpoch", asset: OTHER, roundHint: 42n },
    ]);
  });

  it("stops checkpointing every run once every market has its first week", () => {
    // #given
    const first: EpochView = {
      opening: DEPLOYED + LOOKBACK,
      expiry: OCT_09,
      batchDeadline: DEPLOYED + LOOKBACK,
      windowLength: 7200,
    };
    const s = beforeFirstClose({
      now: DEPLOYED + 3 * 3600,
      markets: [market({ epoch: first, epochAtLatest: false })],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, []);
  });

  it("waits a run when there's no round to hint with", () => {
    // #given
    const s = beforeFirstClose({
      now: DEPLOYED + LOOKBACK,
      markets: [market({ epoch: null, epochAtLatest: false, firstHint: null })],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [{ kind: "checkpoint" }]);
  });

  it("keeps opening the first week in the last 30 minutes before the first close", () => {
    // #given
    const s = beforeFirstClose({ now: OCT_09 - 60 });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [
      { kind: "checkpoint" },
      { kind: "observeClose", asset: NVDA },
      { kind: "createFirstEpoch", asset: NVDA, roundHint: 1188n },
    ]);
  });

  it("leaves a market with no week to createEpoch once the first close has passed", () => {
    // #given: just after the Oct 9 close, a market that never got its first week
    const s = snapshot({
      now: OCT_09 + 600,
      deployedAt: DEPLOYED,
      latestBoundary: { close: OCT_09, creationDeadline: OCT_09 + 3 * 86_400 },
      nextClose: OCT_09 + 7 * 86_400,
      markets: [market({ epoch: null, epochAtLatest: false, roundHint: 1200n, firstHint: 1199n })],
    });
    // #when
    const actions = plan(s);
    // #then
    assert.deepEqual(actions, [
      { kind: "checkpoint" },
      { kind: "observePauses", asset: NVDA },
      { kind: "createEpoch", asset: NVDA, roundHint: 1200n },
    ]);
  });
});
