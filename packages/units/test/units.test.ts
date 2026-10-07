import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
  BPS,
  fee,
  formatFixed,
  gridIsExact,
  InexactValue,
  isOnTick,
  isWholeLots,
  parseFixed,
  pricePerShare,
  toShares,
  value,
  valueExact,
} from "../src/index.ts";

const RAW_UNIT = 10n ** 18n;
const LOT = RAW_UNIT / 100n;
const PRICE_TICK = 100n;

describe("value", () => {
  it("is exact for whole lots at on-tick prices", () => {
    // #given
    const grid = fc.record({
      lots: fc.bigInt({ min: 1n, max: 10n ** 12n }),
      ticks: fc.bigInt({ min: 0n, max: 10n ** 12n }),
    });
    // #when / #then
    fc.assert(
      fc.property(grid, ({ lots, ticks }) => {
        const amount = lots * LOT;
        const price = ticks * PRICE_TICK;
        return valueExact(amount, price, RAW_UNIT) * RAW_UNIT === amount * price;
      }),
    );
  });

  it("brackets the exact product between floor and ceil, at most one apart", () => {
    // #given
    const inputs = fc.record({
      amount: fc.bigInt({ min: 0n, max: 10n ** 30n }),
      price: fc.bigInt({ min: 0n, max: 10n ** 18n }),
    });
    // #when / #then
    fc.assert(
      fc.property(inputs, ({ amount, price }) => {
        const down = value(amount, price, RAW_UNIT, "floor");
        const up = value(amount, price, RAW_UNIT, "ceil");
        return (
          down * RAW_UNIT <= amount * price && up * RAW_UNIT >= amount * price && up - down <= 1n
        );
      }),
    );
  });

  it("refuses an inexact value instead of rounding it", () => {
    // #given
    const amount = 1n;
    const price = 1n;
    // #when
    const compute = (): bigint => valueExact(amount, price, RAW_UNIT);
    // #then
    assert.throws(compute, InexactValue);
  });

  it("rejects negative inputs", () => {
    // #given
    const compute = (): bigint => value(-1n, 1n, RAW_UNIT, "floor");
    // #then
    assert.throws(compute, RangeError);
  });
});

describe("fee", () => {
  it("rounds up to the next base unit", () => {
    // #given
    const inputs = fc.record({
      premium: fc.bigInt({ min: 0n, max: 10n ** 30n }),
      feeBps: fc.bigInt({ min: 0n, max: BPS }),
    });
    // #when / #then
    fc.assert(
      fc.property(inputs, ({ premium, feeBps }) => {
        const charged = fee(premium, feeBps);
        return (
          charged * BPS >= premium * feeBps &&
          (charged === 0n || (charged - 1n) * BPS < premium * feeBps)
        );
      }),
    );
  });
});

describe("lots, ticks and the grid", () => {
  it("accepts whole lots and on-tick prices only", () => {
    // #when
    const results = [
      isWholeLots(3n * LOT, LOT),
      isWholeLots(LOT + 1n, LOT),
      isWholeLots(0n, LOT),
      isOnTick(5_000_000n, PRICE_TICK),
      isOnTick(5_000_001n, PRICE_TICK),
    ];
    // #then
    assert.deepEqual(results, [true, false, false, true, false]);
  });

  it("confirms the configured lot and tick divide exactly", () => {
    // #when
    const results = [gridIsExact(LOT, PRICE_TICK, RAW_UNIT), gridIsExact(LOT, 1n, RAW_UNIT)];
    // #then
    assert.deepEqual(results, [true, false]);
  });
});

describe("display conversion", () => {
  it("shows a raw-token price per share using the UI multiplier", () => {
    // #given: NVDA's multiplier read on chain at block 81944099
    const multiplier = 1_000_775_159_164_630_595n;
    const target = 210_000_000n;
    // #when
    const perShare = pricePerShare(target, multiplier);
    // #then
    assert.equal(formatFixed(perShare, 6), "209.837342");
  });

  it("never shows more shares than the raw amount converts to", () => {
    // #given
    const inputs = fc.record({
      raw: fc.bigInt({ min: 0n, max: 10n ** 30n }),
      multiplier: fc.bigInt({ min: 1n, max: 10n ** 20n }),
    });
    // #when / #then
    fc.assert(
      fc.property(inputs, ({ raw, multiplier }) => {
        const shares = toShares(raw, multiplier);
        return shares * 10n ** 18n <= raw * multiplier;
      }),
    );
  });

  it("formats fixed-point amounts without trailing zeros", () => {
    // #when
    const results = [
      formatFixed(239_430_000n, 6),
      formatFixed(5n, 6),
      formatFixed(0n, 6),
      formatFixed(-1_500_000n, 6),
    ];
    // #then
    assert.deepEqual(results, ["239.43", "0.000005", "0", "-1.5"]);
  });

  it("parses what it formats back to the same amount", () => {
    // #given
    const amounts = fc.bigInt({ min: 0n, max: 10n ** 30n });
    // #when / #then
    fc.assert(fc.property(amounts, (amount) => parseFixed(formatFixed(amount, 18), 18) === amount));
  });

  it("refuses typed amounts it would have to round or guess at", () => {
    // #when
    const results = [
      parseFixed("0.0000001", 6),
      parseFixed("1,000", 6),
      parseFixed("-1", 6),
      parseFixed(".5", 6),
      parseFixed("1e3", 6),
      parseFixed("", 6),
    ];
    // #then
    assert.deepEqual(results, [null, null, null, null, null, null]);
  });
});
