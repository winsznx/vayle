import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dollars, easternClock, easternTime, premium, tokens } from "../src/format.ts";

describe("format", () => {
  it("shows prices in dollars and cents, cut rather than rounded", () => {
    // #then
    assert.deepEqual([dollars(245_000_000n), dollars(1_234_567_899n)], ["$245.00", "$1,234.56"]);
  });

  it("keeps four places for a per-token premium", () => {
    // #then
    assert.equal(premium(2_471_300n), "$2.4713");
  });

  it("shows token amounts to the 0.01 lot", () => {
    // #then
    assert.equal(tokens(1_500_000_000_000_000_000n, "NVDA"), "1.50 NVDA");
  });

  it("keeps a time and its zone together so it never wraps across lines", () => {
    // #given
    const fridayClose = 1_791_576_000;
    // #then
    assert.deepEqual(
      [easternTime(fridayClose), easternClock(fridayClose)],
      ["Fri, Oct 9, 4:00\u00a0PM\u00a0EDT", "4:00\u00a0PM\u00a0EDT"],
    );
  });
});
