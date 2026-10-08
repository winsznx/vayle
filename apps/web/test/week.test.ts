import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasBatch, ladder, phase, progressOf, stagesOf, type Epoch } from "../src/app/week.ts";

const OCT_02 = 1_790_971_200;
const epoch: Epoch = {
  opening: OCT_02,
  expiry: OCT_02 + 7 * 86_400,
  batchDeadline: 1_791_207_000 - 48_600,
  windowLength: 7200,
  referencePrice: 238_410_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
  priceTick: 100n,
  lot: 10n ** 16n,
  rawUnit: 10n ** 18n,
};

describe("ladder", () => {
  it("lists out-of-the-money strikes on the week's tick within its band of the close, highest first", () => {
    // #when
    const rungs = ladder(epoch);
    // #then: calls from $240 to $260, puts from $235 down to $215
    assert.deepEqual(
      rungs.map((r) => [Number(r.strike / 1_000_000n), r.side]),
      [
        [260, "sell"],
        [255, "sell"],
        [250, "sell"],
        [245, "sell"],
        [240, "sell"],
        [235, "buy"],
        [230, "buy"],
        [225, "buy"],
        [220, "buy"],
        [215, "buy"],
      ],
    );
  });

  it("follows another market's tick and band the same way", () => {
    // #given a $30 token listed on a $0.50 step within 5%
    const cheaper: Epoch = {
      ...epoch,
      referencePrice: 30_120_000n,
      strikeTick: 500_000n,
      strikeRangeBps: 500,
    };
    // #when
    const rungs = ladder(cheaper);
    // #then: sells from $30.50 to $31.50 and buys from $30.00 down to $29.00, on the step
    assert.deepEqual(
      rungs.map((r) => [Number(r.strike) / 1_000_000, r.side]),
      [
        [31.5, "sell"],
        [31, "sell"],
        [30.5, "sell"],
        [30, "buy"],
        [29.5, "buy"],
        [29, "buy"],
      ],
    );
  });

  it("leaves out a strike exactly at the close", () => {
    // #when
    const rungs = ladder({ ...epoch, referencePrice: 240_000_000n });
    // #then
    assert.ok(!rungs.some((r) => r.strike === 240_000_000n));
  });
});

describe("phase", () => {
  it("follows the week from settlement to bidding to live to expiry", () => {
    // #when
    const phases = [OCT_02 + 60, OCT_02 + 7200, epoch.batchDeadline, epoch.expiry].map((t) =>
      phase(epoch, t),
    );
    // #then
    assert.deepEqual(phases, ["settling", "bidding", "live", "expired"]);
  });
});

// The first week a market opens after its deploy: opened mid-week at deploy time, recorded with its
// batch deadline at its opening, and closing at the first scheduled close.
const DEPLOYED = OCT_02 + 5 * 86_400 + 3 * 3600;
const firstWeek: Epoch = {
  ...epoch,
  opening: DEPLOYED,
  expiry: OCT_02 + 7 * 86_400,
  batchDeadline: DEPLOYED,
};

describe("hasBatch", () => {
  it("is true for a week whose batch deadline comes after its opening", () => {
    // #then
    assert.equal(hasBatch(epoch), true);
  });

  it("is false for a week recorded with its batch deadline at or before its opening", () => {
    // #when
    const weeks = [firstWeek, { ...firstWeek, batchDeadline: firstWeek.opening - 1 }];
    // #then
    assert.deepEqual(weeks.map(hasBatch), [false, false]);
  });
});

describe("phase in a week without a batch", () => {
  it("is live from the opening to the close and never settling or bidding", () => {
    // #given
    const times = [DEPLOYED, DEPLOYED + 7200, DEPLOYED + 4 * 3600, firstWeek.expiry - 1];
    // #when
    const phases = times.map((t) => phase(firstWeek, t));
    // #then
    assert.deepEqual(phases, ["live", "live", "live", "live"]);
  });

  it("ends at the close", () => {
    // #then
    assert.equal(phase(firstWeek, firstWeek.expiry), "expired");
  });
});

describe("stagesOf", () => {
  it("runs a week with a batch from its close through bids, batch and week to the next close", () => {
    // #when
    const stages = stagesOf(epoch);
    // #then
    assert.deepEqual(stages, [
      { key: "close", at: OCT_02 },
      { key: "bids", at: OCT_02 + 7200 },
      { key: "batch", at: OCT_02 + 4 * 3600 },
      { key: "week", at: epoch.batchDeadline },
      { key: "next-close", at: epoch.expiry },
    ]);
  });

  it("gives a week without a batch one stretch of quotes to the close, then the exercise window", () => {
    // #when
    const stages = stagesOf(firstWeek);
    // #then
    assert.deepEqual(stages, [
      { key: "quotes", at: DEPLOYED },
      { key: "window", at: firstWeek.expiry },
      { key: "window-end", at: firstWeek.expiry + 7200 },
    ]);
  });
});

describe("progressOf", () => {
  it("puts the clock halfway through the quote stretch at a quarter of a three-stage track", () => {
    // #given
    const stages = stagesOf(firstWeek);
    const halfway = (firstWeek.opening + firstWeek.expiry) / 2;
    // #when
    const progress = progressOf(stages, halfway);
    // #then
    assert.deepEqual(progress, { index: 0, fill: 0.25 });
  });

  it("marks the exercise window as current from the close until it ends", () => {
    // #given
    const stages = stagesOf(firstWeek);
    // #when
    const progress = progressOf(stages, firstWeek.expiry + 3600);
    // #then
    assert.deepEqual(progress, { index: 1, fill: 0.75 });
  });

  it("is full once the last stage has passed", () => {
    // #when
    const progress = progressOf(stagesOf(epoch), epoch.expiry + 1);
    // #then
    assert.deepEqual(progress, { index: 4, fill: 1 });
  });
});
