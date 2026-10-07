import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { advanceOptions, UsageError } from "../src/options.ts";

const FEED_DECIMALS = 8;

describe("advanceOptions", () => {
  it("goes to the next moment with the keeper and the latest price by default", () => {
    // #when
    const options = advanceOptions([], FEED_DECIMALS);
    // #then
    assert.deepEqual(options, { minutes: null, keeper: true, closeAt: null });
  });

  it("reads a chosen close price in the feed's decimals", () => {
    // #when
    const options = advanceOptions(["--close-at", "250.05"], FEED_DECIMALS);
    // #then
    assert.equal(options.closeAt, 25_005_000_000n);
  });

  it("takes minutes, a dead keeper and a close price together", () => {
    // #when
    const options = advanceOptions(["30", "--without-keeper", "--close-at", "240"], FEED_DECIMALS);
    // #then
    assert.deepEqual(options, { minutes: 30, keeper: false, closeAt: 24_000_000_000n });
  });

  it("refuses a close price that isn't a plain dollar amount", () => {
    // #when
    const parse = (): unknown => advanceOptions(["--close-at", "$250"], FEED_DECIMALS);
    // #then
    assert.throws(parse, UsageError);
  });

  it("refuses more decimal places than the feed has", () => {
    // #when
    const parse = (): unknown => advanceOptions(["--close-at", "250.000000001"], FEED_DECIMALS);
    // #then
    assert.throws(parse, UsageError);
  });

  it("refuses --close-at with no price after it", () => {
    // #when
    const parse = (): unknown => advanceOptions(["--close-at"], FEED_DECIMALS);
    // #then
    assert.throws(parse, UsageError);
  });

  it("refuses a zero close price", () => {
    // #when
    const parse = (): unknown => advanceOptions(["--close-at", "0"], FEED_DECIMALS);
    // #then
    assert.throws(parse, UsageError);
  });
});
