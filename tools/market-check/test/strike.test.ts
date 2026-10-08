import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strikeStep } from "../src/strike.ts";

const FEED_DECIMALS = 8;
const USDG_DECIMALS = 6;
const PERCENT = 2;

// A feed answer for a dollar price given in cents.
function answer(cents: bigint): bigint {
  return cents * 10n ** BigInt(FEED_DECIMALS - 2);
}

function step(cents: bigint): bigint | null {
  return strikeStep(answer(cents), FEED_DECIMALS, USDG_DECIMALS, PERCENT);
}

describe("strikeStep", () => {
  it("gives $5 for $240, $0.50 for $30 and $10 for $600", () => {
    // #given
    const prices = [24_000n, 3_000n, 60_000n];
    // #when
    const steps = prices.map(step);
    // #then
    assert.deepEqual(steps, [5_000_000n, 500_000n, 10_000_000n]);
  });

  it("switches from 1 to 2 at the square root of 2", () => {
    // #given
    // 2% of $70.50 is $1.41, whose square is under 2. 2% of $71.00 is $1.42, whose square is over.
    const prices = [7_050n, 7_100n];
    // #when
    const steps = prices.map(step);
    // #then
    assert.deepEqual(steps, [1_000_000n, 2_000_000n]);
  });

  it("switches from 2 to 5 at the square root of 10", () => {
    // #given
    // 2% of $158.00 is $3.16 (squared 9.9856). 2% of $158.50 is $3.17 (squared 10.0489).
    const prices = [15_800n, 15_850n];
    // #when
    const steps = prices.map(step);
    // #then
    assert.deepEqual(steps, [2_000_000n, 5_000_000n]);
  });

  it("switches from 5 to 10 at the square root of 50", () => {
    // #given
    // 2% of $353.50 is $7.07 (squared 49.98). 2% of $354.00 is $7.08 (squared 50.13).
    const prices = [35_350n, 35_400n];
    // #when
    const steps = prices.map(step);
    // #then
    assert.deepEqual(steps, [5_000_000n, 10_000_000n]);
  });

  it("works in any decade, down to one USDG base unit", () => {
    // #given
    // 2% of $0.04 is 800 base units, nearest 1,000. 2% of $0.00004 is 0.8 of a unit, nearest 1.
    const answers = [4_000_000n, 4_000n];
    // #when
    const steps = answers.map((a) => strikeStep(a, FEED_DECIMALS, USDG_DECIMALS, PERCENT));
    // #then
    assert.deepEqual(steps, [1_000n, 1n]);
  });

  it("gives nothing when the step is under one base unit or the price isn't positive", () => {
    // #given
    // 2% of $0.00001 is 0.2 of a base unit, which rounds to 0.2 on the series.
    const answers = [1_000n, 0n, -5n];
    // #when
    const steps = answers.map((a) => strikeStep(a, FEED_DECIMALS, USDG_DECIMALS, PERCENT));
    // #then
    assert.deepEqual(steps, [null, null, null]);
  });
});
