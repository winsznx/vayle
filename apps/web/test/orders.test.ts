import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderState, SeriesState } from "@vayle/market";
import { describeOrder } from "../src/orders.ts";
import type { Epoch } from "../src/week.ts";

const OCT_02 = 1_790_971_200;
const ONE = 10n ** 18n;
const epoch: Epoch = {
  opening: OCT_02,
  expiry: OCT_02 + 7 * 86_400,
  batchDeadline: OCT_02 + 2 * 86_400,
  windowLength: 7200,
  referencePrice: 238_410_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
  priceTick: 100n,
  lot: 10n ** 16n,
  rawUnit: ONE,
};

function order(overrides: Partial<OrderState> = {}): OrderState {
  return {
    id: 1n,
    owner: "0x00000000000000000000000000000000000000bb",
    asset: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    side: 0,
    status: "active",
    target: 245_000_000n,
    minPremium: 0n,
    flip: false,
    flipTarget: 0n,
    size: ONE,
    committed: 0n,
    series: 0n,
    frozen: false,
    ...overrides,
  };
}

describe("describeOrder", () => {
  it("names the order with its amount and price", () => {
    // #when
    const line = describeOrder(order(), null, epoch, OCT_02 + 60, "NVDA");
    // #then
    assert.deepEqual([line.title, line.price, line.side], ["Sell 1.00 NVDA at", "$245.00", "sell"]);
  });

  it("says a sell order below the close skips the week because the market passed it", () => {
    // #when
    const line = describeOrder(order({ target: 235_000_000n }), null, epoch, OCT_02 + 60, "NVDA");
    // #then
    assert.equal(line.status, "Skipping this week: the market passed your price.");
  });

  it("says a frozen order is in the batch and can't change yet", () => {
    // #when
    const line = describeOrder(order({ frozen: true }), null, epoch, OCT_02 + 3 * 3600, "NVDA");
    // #then
    assert.deepEqual(
      [line.status, line.action],
      ["In this week's batch. You can change or cancel it once the batch finishes.", "wait"],
    );
  });

  it("says what happens to a sell order in this week's trade, in plain words", () => {
    // #given
    const series: SeriesState = {
      id: 9n,
      side: 0,
      strike: 245_000_000n,
      expiry: BigInt(epoch.expiry),
      windowEnd: BigInt(epoch.expiry + 7200),
      settled: false,
    };
    // #when
    const line = describeOrder(
      order({ series: 9n, committed: ONE }),
      series,
      epoch,
      OCT_02 + 5 * 3600,
      "NVDA",
    );
    // #then
    assert.equal(
      line.status,
      "It sells at $245.00 if NVDA is above that when the week ends on Fri, Oct 9, 4:00\u00a0PM\u00a0EDT.",
    );
  });

  it("names the part of a buy order that's in this week's trade when only part of it filled", () => {
    // #given
    const series: SeriesState = {
      id: 7n,
      side: 1,
      strike: 230_000_000n,
      expiry: BigInt(epoch.expiry),
      windowEnd: BigInt(epoch.expiry + 7200),
      settled: false,
    };
    // #when
    const line = describeOrder(
      order({ side: 1, target: 230_000_000n, series: 7n, committed: 4n * 10n ** 17n }),
      series,
      epoch,
      OCT_02 + 5 * 3600,
      "NVDA",
    );
    // #then
    assert.equal(
      line.status,
      "0.40 NVDA of it buys at $230.00 if NVDA is below that when the week ends on Fri, Oct 9, 4:00\u00a0PM\u00a0EDT.",
    );
  });

  it("offers to settle once the written week has settled", () => {
    // #given
    const series: SeriesState = {
      id: 9n,
      side: 0,
      strike: 245_000_000n,
      expiry: BigInt(epoch.expiry),
      windowEnd: BigInt(epoch.expiry + 7200),
      settled: true,
    };
    // #when
    const line = describeOrder(
      order({ series: 9n, committed: ONE }),
      series,
      epoch,
      epoch.expiry + 9000,
      "NVDA",
    );
    // #then
    assert.equal(line.action, "settle");
  });
});
