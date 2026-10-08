import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregatorRound, nextWindow, phaseOf } from "../src/rounds.ts";

describe("round IDs", () => {
  it("splits a proxy round ID into its phase and the aggregator's round", () => {
    // #given
    // NVDA's feed proxy reported round 18446744073709552799 at block 82018194.
    const roundId = 18_446_744_073_709_552_799n;
    // #when
    const parts = [phaseOf(roundId), aggregatorRound(roundId)];
    // #then
    assert.deepEqual(parts, [1n, 1_183n]);
  });
});

describe("nextWindow", () => {
  const round = (updatedAt: number) => ({ roundId: 1n, answer: 1n, updatedAt });

  it("sizes the next window from the rate seen so far, with a quarter more", () => {
    // #given
    // 101 rounds over 100,000 s is one per 1,000 s, and 40,000 s are left to cover.
    const newest = round(1_100_000);
    const oldest = round(1_000_000);
    // #when
    const size = nextWindow(newest, oldest, 101, 960_000);
    // #then
    assert.equal(size, 58);
  });

  it("stays within its floor and ceiling", () => {
    // #given
    const newest = round(1_000_100);
    const oldest = round(1_000_000);
    // #when
    const sizes = [nextWindow(newest, oldest, 101, 999_999), nextWindow(newest, oldest, 2, 0)];
    // #then
    assert.deepEqual(sizes, [32, 2_048]);
  });
});
