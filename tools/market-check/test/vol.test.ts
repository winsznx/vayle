import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { realizedVolBps, TooFewCloses } from "../src/vol.ts";

describe("realizedVolBps", () => {
  it("annualizes the sample deviation of alternating 10% moves", () => {
    // #given
    // Returns of +ln(1.1) and -ln(1.1) in turn have mean 0 and sample deviation
    // ln(1.1) * sqrt(4/3), so the annualized figure is that times sqrt(252): 1.747064 = 17,471 bps.
    const closes = [100n, 110n, 100n, 110n, 100n];
    // #when
    const bps = realizedVolBps(closes);
    // #then
    assert.equal(bps, 17_471);
  });

  it("matches an independent computation over twenty closes", () => {
    // #given
    // The expected figure is Python's statistics.stdev of the log returns, times sqrt(252), in bps.
    const closes = [
      23_719_372_047n,
      23_604_500_000n,
      24_012_850_000n,
      23_880_000_000n,
      24_155_125_000n,
      23_990_000_000n,
      24_300_750_000n,
      24_425_000_000n,
      24_101_500_000n,
      23_877_000_000n,
      23_650_250_000n,
      23_999_000_000n,
      24_210_000_000n,
      24_480_500_000n,
      24_395_000_000n,
      24_611_250_000n,
      24_502_000_000n,
      24_259_750_000n,
      24_020_000_000n,
      24_188_500_000n,
    ];
    // #when
    const bps = realizedVolBps(closes);
    // #then
    assert.equal(bps, 1_599);
  });

  it("is zero for a price that never moves", () => {
    // #given
    const closes = [5n, 5n, 5n, 5n];
    // #when
    const bps = realizedVolBps(closes);
    // #then
    assert.equal(bps, 0);
  });

  it("needs at least two returns", () => {
    // #given
    const closes = [100n, 101n];
    // #when
    const compute = (): number => realizedVolBps(closes);
    // #then
    assert.throws(compute, TooFewCloses);
  });

  it("refuses a close that isn't positive", () => {
    // #given
    const closes = [100n, 0n, 101n];
    // #when
    const compute = (): number => realizedVolBps(closes);
    // #then
    assert.throws(compute, RangeError);
  });
});
