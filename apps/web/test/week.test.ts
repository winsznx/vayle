import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ladder, phase, type Epoch } from "../src/app/week.ts";

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
  it("lists out-of-the-money strikes on the $5 tick within 10% of the close, highest first", () => {
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
