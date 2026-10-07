import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import { bidPremium, blackScholes, effectiveDividendYield, normalCdf } from "../src/pricing.ts";

function close(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

describe("blackScholes", () => {
  it("matches the textbook at-the-money example", () => {
    // #given: S 100, K 100, one year, 20% vol, 5% rate, no dividends
    const base = { spot: 100, strike: 100, years: 1, vol: 0.2, rate: 0.05, dividendYield: 0 };
    // #when
    const prices = [
      blackScholes({ ...base, side: "call" }),
      blackScholes({ ...base, side: "put" }),
    ];
    // #then: 10.4506 and 5.5735
    assert.ok(close(prices[0] ?? 0, 10.4506, 1e-4) && close(prices[1] ?? 0, 5.5735, 1e-4));
  });

  it("matches the textbook six-month example", () => {
    // #given: S 42, K 40, half a year, 20% vol, 10% rate
    const base = { spot: 42, strike: 40, years: 0.5, vol: 0.2, rate: 0.1, dividendYield: 0 };
    // #when
    const prices = [
      blackScholes({ ...base, side: "call" }),
      blackScholes({ ...base, side: "put" }),
    ];
    // #then: 4.76 and 0.81
    assert.ok(close(prices[0] ?? 0, 4.759, 1e-3) && close(prices[1] ?? 0, 0.8086, 1e-3));
  });

  it("satisfies put-call parity with a dividend yield", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 50, max: 500, noNaN: true }),
        fc.double({ min: 50, max: 500, noNaN: true }),
        fc.double({ min: 1 / 365, max: 1, noNaN: true }),
        fc.double({ min: 0.05, max: 1.5, noNaN: true }),
        (spot, strike, years, vol) => {
          // #given
          const base = { spot, strike, years, vol, rate: 0.03, dividendYield: 0.002 };
          // #when
          const call = blackScholes({ ...base, side: "call" });
          const put = blackScholes({ ...base, side: "put" });
          // #then: C - P = S e^-qT - K e^-rT
          const parity = spot * Math.exp(-0.002 * years) - strike * Math.exp(-0.03 * years);
          return close(call - put, parity, 1e-6 * spot);
        },
      ),
    );
  });

  it("is worth its intrinsic value at expiry", () => {
    // #when
    const value = blackScholes({
      side: "put",
      spot: 90,
      strike: 100,
      years: 0,
      vol: 0.4,
      rate: 0,
      dividendYield: 0,
    });
    // #then
    assert.equal(value, 10);
  });
});

describe("normalCdf", () => {
  it("is a half at zero and symmetric", () => {
    // #then
    assert.ok(close(normalCdf(0), 0.5, 1e-7) && close(normalCdf(1) + normalCdf(-1), 1, 1e-7));
  });
});

describe("effectiveDividendYield", () => {
  it("keeps the withheld 30% of a gross yield", () => {
    // #then
    assert.ok(close(effectiveDividendYield(0.01), 0.003, 1e-12));
  });
});

describe("bidPremium", () => {
  it("takes the edge off fair value and floors to the tick", () => {
    // #given: fair 2.4567891 USDG, 10% edge, 6 decimals, tick 100
    // #when
    const bid = bidPremium(2.4567891, 1000, 6, 100n);
    // #then: 2.21111019 -> 2211110 -> 2211100
    assert.equal(bid, 2_211_100n);
  });

  it("doesn't bid under one tick", () => {
    // #then
    assert.equal(bidPremium(0.00005, 0, 6, 100n), null);
  });
});
