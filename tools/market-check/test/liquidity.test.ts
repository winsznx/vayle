import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isqrt,
  MAX_QUOTES,
  nextSize,
  recordQuote,
  shortfallBps,
  sizeForValue,
  startSearch,
  valueAtFeed,
  withinLimit,
  type PriceUnits,
} from "../src/liquidity.ts";

// $250.00 on an 8-decimal feed, an 18-decimal token and 6-decimal USDG.
const PRICE: PriceUnits = {
  answer: 25_000_000_000n,
  feedDecimals: 8,
  tokenDecimals: 18,
  usdgDecimals: 6,
};
const VALUE = 2_500_000_000n;

// Runs a search against a route that stays within the limit up to `limit` raw units.
function search(cap: bigint, limit: bigint): { within: bigint | null; quotes: number } {
  let state = startSearch(cap, cap <= limit);
  for (let size = nextSize(state); size !== null; size = nextSize(state)) {
    state = recordQuote(state, size, size <= limit);
  }
  return { within: state.within, quotes: state.quotes };
}

describe("cap size and value at the feed's price", () => {
  it("sells ten tokens for a $2,500 cap at $250", () => {
    // #given
    const cap = 2_500_000_000n;
    // #when
    const size = sizeForValue(cap, PRICE);
    // #then
    assert.equal(size, 10n * 10n ** 18n);
  });

  it("values ten tokens at $2,500 in USDG base units", () => {
    // #given
    const amount = 10n * 10n ** 18n;
    // #when
    const value = valueAtFeed(amount, PRICE);
    // #then
    assert.equal(value, VALUE);
  });

  it("rounds a size that doesn't divide down to whole raw units", () => {
    // #given
    const price = { ...PRICE, answer: 30_000_000_000n };
    // #when
    const size = sizeForValue(1_000_000n, price);
    // #then
    // $1 at $300 is 1/300 of a token: 3,333,333,333,333,333.33 raw units.
    assert.equal(size, 3_333_333_333_333_333n);
  });
});

describe("slippage against the feed's value", () => {
  it("passes a quote exactly 100 bps short and fails one a base unit lower", () => {
    // #given
    const atLimit = 2_475_000_000n;
    // #when
    const results = [withinLimit(atLimit, VALUE, 100), withinLimit(atLimit - 1n, VALUE, 100)];
    // #then
    assert.deepEqual(results, [true, false]);
  });

  it("reports the shortfall in basis points rounded up to hundredths", () => {
    // #given
    const outs = [2_475_000_000n, 2_474_999_999n, 2_500_000_000n, 2_525_000_000n, 2_500_000_001n];
    // #when
    const bps = outs.map((out) => shortfallBps(out, VALUE));
    // #then
    assert.deepEqual(bps, [100, 100.01, 0, -100, 0]);
  });

  it("refuses to compare with a value of zero", () => {
    // #given
    const value = 0n;
    // #when
    const compare = (): number => shortfallBps(1n, value);
    // #then
    assert.throws(compare, RangeError);
  });
});

describe("isqrt", () => {
  it("is the floor of the square root", () => {
    // #given
    const inputs = [0n, 1n, 2n, 3n, 4n, 15n, 16n, 10n ** 38n, 10n ** 38n - 1n];
    // #when
    const roots = inputs.map(isqrt);
    // #then
    assert.deepEqual(roots, [0n, 1n, 1n, 1n, 2n, 3n, 4n, 10n ** 19n, 10n ** 19n - 1n]);
  });
});

describe("the search for the largest size within the limit", () => {
  it("closes in on a limit above the cap within eight quotes", () => {
    // #given
    const cap = 1_000_000n;
    const limit = 37_000_000n;
    // #when
    const result = search(cap, limit);
    // #then
    // Eight halvings of a 1,024x bracket in log terms leave a ratio of 1024^(1/256), under 1.03.
    assert.deepEqual(
      {
        quotes: result.quotes,
        close:
          result.within !== null && result.within <= limit && result.within * 103n >= limit * 100n,
      },
      { quotes: MAX_QUOTES, close: true },
    );
  });

  it("closes in on a limit below the cap after trying the bracket's floor", () => {
    // #given
    const cap = 1_000_000n;
    const limit = 400_000n;
    // #when
    const result = search(cap, limit);
    // #then
    // The floor probe leaves seven halvings of about ten doublings, a ratio under 1.06.
    assert.deepEqual(
      {
        quotes: result.quotes,
        close:
          result.within !== null && result.within <= limit && result.within * 106n >= limit * 100n,
      },
      { quotes: MAX_QUOTES, close: true },
    );
  });

  it("stops after one quote when even the floor breaks the limit", () => {
    // #given
    const cap = 1_000_000n;
    const limit = 100n;
    // #when
    const result = search(cap, limit);
    // #then
    assert.deepEqual(result, { within: null, quotes: 1 });
  });

  it("keeps the cap when every larger size breaks the limit", () => {
    // #given
    const cap = 1_000_000n;
    // #when
    const result = search(cap, cap);
    // #then
    assert.equal(result.within, cap);
  });
});
