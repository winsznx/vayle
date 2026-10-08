import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderState, SeriesState } from "@vayle/market";
import { describeOrder, nameOf } from "../src/app/orders.ts";
import type { Epoch } from "../src/app/week.ts";

const OCT_02 = 1_790_971_200;
const ONE = 10n ** 18n;
// A made-up market's token: targets read the same on every listed Stock Token.
const unit = { symbol: "ABC", decimals: 18, places: 2 };
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
    asset: "0x00000000000000000000000000000000000000cc",
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
  it("names a target by its side and amount, with its price", () => {
    // #when
    const line = describeOrder(order(), null, epoch, OCT_02 + 60, unit);
    // #then
    assert.deepEqual(
      [nameOf(line), line.price, line.side],
      ["Sell target for 1.00 ABC", "$245.00", "sell"],
    );
  });

  it("says a sell order below the close skips the week because the market passed it", () => {
    // #when
    const line = describeOrder(order({ target: 235_000_000n }), null, epoch, OCT_02 + 60, unit);
    // #then
    assert.equal(line.status, "Skipping this week: the market passed your price.");
  });

  it("labels an order in this week's trade, a frozen one and one the market passed", () => {
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
    const labels = [
      describeOrder(order({ series: 9n, committed: ONE }), series, epoch, OCT_02 + 5 * 3600, unit),
      describeOrder(order({ frozen: true }), null, epoch, OCT_02 + 3 * 3600, unit),
      describeOrder(order({ target: 235_000_000n }), null, epoch, OCT_02 + 60, unit),
    ].map((line) => line.chip);
    // #then
    assert.deepEqual(labels, [
      { label: "This week", tone: "brand" },
      { label: "In the batch", tone: "brand" },
      { label: "Skipping", tone: "plain" },
    ]);
  });

  it("says a frozen order is in the batch and can't change yet", () => {
    // #when
    const line = describeOrder(order({ frozen: true }), null, epoch, OCT_02 + 3 * 3600, unit);
    // #then
    assert.deepEqual(
      [line.status, line.action],
      ["In this week's batch. You can change or cancel it once the batch finishes.", "wait"],
    );
  });

  it("says what happens to a sell target in this week's trade with the signed-off words", () => {
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
      unit,
    );
    // #then
    assert.equal(
      line.status,
      "If ABC closes above $245.00 on Fri, Oct 9, 4:00\u00a0PM\u00a0ET, your tokens sell at exactly your price.",
    );
  });

  it("offers to stop an order renewing while its week runs", () => {
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
      unit,
    );
    // #then
    assert.equal(line.action, "stop-renewing");
  });

  it("says an order that was stopped won't renew after this week", () => {
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
      order({ series: 9n, committed: ONE, status: "cancelled" }),
      series,
      epoch,
      OCT_02 + 5 * 3600,
      unit,
    );
    // #then
    assert.deepEqual(
      [line.action, line.status.endsWith("It won't renew after this week.")],
      ["wait", true],
    );
  });

  it("names the part of a buy target that's in this week's trade when only part of it filled", () => {
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
      unit,
    );
    // #then
    assert.equal(
      line.status,
      "If ABC closes below $230.00 on Fri, Oct 9, 4:00\u00a0PM\u00a0ET, you buy 0.40 ABC at that price, even if the close is lower.",
    );
  });

  it("waits instead of offering to settle when finalize would find the window still open", () => {
    // #given
    const series: SeriesState = {
      id: 9n,
      side: 0,
      strike: 245_000_000n,
      expiry: BigInt(epoch.expiry),
      windowEnd: BigInt(epoch.expiry + 7200),
      settled: false,
    };
    const heldUntil = BigInt(epoch.expiry + 4 * 3600);
    // #when
    const line = describeOrder(
      order({ series: 9n, committed: ONE }),
      series,
      epoch,
      epoch.expiry + 3 * 3600,
      unit,
      heldUntil,
    );
    // #then
    assert.deepEqual(
      [line.action, line.status],
      [
        "wait",
        "The week ended, and its result is final from Fri, Oct 9, 8:00\u00a0PM\u00a0ET at the earliest. The chain has been quiet, and quiet time keeps the window open longer.",
      ],
    );
  });

  it("says a waiting target in a week without a batch fills by quote until the close", () => {
    // #given
    const firstWeek: Epoch = {
      ...epoch,
      opening: OCT_02 + 5 * 86_400,
      batchDeadline: OCT_02 + 5 * 86_400,
    };
    // #when
    const line = describeOrder(order(), null, firstWeek, OCT_02 + 5 * 86_400 + 3 * 3600, unit);
    // #then
    assert.deepEqual(
      [line.status, line.chip.label],
      [
        "Waiting. It fills if the maker quotes it before the close on Fri, Oct 9, 4:00\u00a0PM\u00a0ET.",
        "Waiting",
      ],
    );
  });

  it("waits for the next week once the week's close has passed", () => {
    // #when
    const line = describeOrder(order(), null, epoch, epoch.expiry + 60, unit);
    // #then
    assert.equal(line.status, "Waiting for the next week to open.");
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
      unit,
    );
    // #then
    assert.equal(line.action, "settle");
  });
});
