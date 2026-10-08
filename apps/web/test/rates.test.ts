import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { batchBidsShow, rateOf, sheetRows, type RateInputs } from "../src/app/rates.ts";
import { ladder, type Epoch } from "../src/app/week.ts";

const OCT_09 = 1_791_576_000;
const epoch: Epoch = {
  opening: OCT_09,
  expiry: OCT_09 + 7 * 86_400,
  batchDeadline: OCT_09 + 2 * 86_400 + 4 * 3600,
  windowLength: 7200,
  referencePrice: 238_410_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
  priceTick: 100n,
  lot: 10n ** 16n,
  rawUnit: 10n ** 18n,
};
// Inside the bid window, and later in the week once the batch deadline has passed.
const BIDDING = OCT_09 + 3 * 3600;
const MIDWEEK = OCT_09 + 4 * 86_400;
const SELL = 245_000_000n;
const BUY = 230_000_000n;
const OTHER_BUY = 225_000_000n;

function inputs(overrides: Partial<RateInputs> = {}): RateInputs {
  return {
    epoch,
    now: MIDWEEK,
    batch: new Map([[SELL, 1_200_000n]]),
    readsSheet: true,
    maker: {
      computedAt: MIDWEEK - 60,
      sell: new Map([[SELL, 1_100_000n]]),
      buy: new Map([[BUY, 900_000n]]),
    },
    ...overrides,
  };
}

const sides = (rows: ReturnType<typeof sheetRows>): string[] =>
  rows.map((r) => `${r.rung.side}:${Number(r.rung.strike / 1_000_000n)}`);

describe("batchBidsShow", () => {
  it("shows batch bids all week in a build without a bid sheet", () => {
    // #then
    assert.equal(batchBidsShow(inputs({ readsSheet: false, maker: null })), true);
  });

  it("shows batch bids only while the bid window runs in a build with one", () => {
    // #when
    const shows = [BIDDING, MIDWEEK].map((now) => batchBidsShow(inputs({ now })));
    // #then
    assert.deepEqual(shows, [true, false]);
  });

  it("never shows batch bids in a week without a batch when the build reads a sheet", () => {
    // #given
    const firstWeek: Epoch = { ...epoch, batchDeadline: epoch.opening };
    // #then
    assert.equal(batchBidsShow(inputs({ epoch: firstWeek, now: BIDDING })), false);
  });
});

describe("rateOf", () => {
  it("takes the batch bid during the bid window, ahead of the maker's current bid", () => {
    // #when
    const rate = rateOf({ strike: SELL, side: "sell" }, inputs({ now: BIDDING }));
    // #then
    assert.deepEqual(rate, { premium: 1_200_000n, source: "batch" });
  });

  it("takes the maker's current bid outside the bid window", () => {
    // #when
    const rate = rateOf({ strike: SELL, side: "sell" }, inputs());
    // #then
    assert.deepEqual(rate, { premium: 1_100_000n, source: "maker" });
  });

  it("takes batch bids only, all week, without a bid sheet", () => {
    // #when
    const rates = [
      rateOf({ strike: SELL, side: "sell" }, inputs({ readsSheet: false, maker: null })),
      rateOf({ strike: BUY, side: "buy" }, inputs({ readsSheet: false, maker: null })),
    ];
    // #then
    assert.deepEqual(rates, [{ premium: 1_200_000n, source: "batch" }, null]);
  });
});

describe("sheetRows", () => {
  it("shows every sell target and only the buy targets the maker bids on", () => {
    // #when
    const rows = sheetRows(ladder(epoch), inputs());
    // #then
    assert.deepEqual(sides(rows), [
      "sell:260",
      "sell:255",
      "sell:250",
      "sell:245",
      "sell:240",
      "buy:230",
    ]);
  });

  it("shows a buy target with a batch bid during the bid window", () => {
    // #given
    const withBatchBuy = inputs({ now: BIDDING, batch: new Map([[OTHER_BUY, 700_000n]]) });
    // #when
    const buys = sheetRows(ladder(epoch), withBatchBuy).filter((r) => r.rung.side === "buy");
    // #then
    assert.deepEqual(sides(buys), ["buy:230", "buy:225"]);
  });

  it("hides every buy target when nobody bids on any", () => {
    // #when
    const rows = sheetRows(ladder(epoch), inputs({ readsSheet: false, maker: null }));
    // #then
    assert.equal(
      rows.some((r) => r.rung.side === "buy"),
      false,
    );
  });
});
