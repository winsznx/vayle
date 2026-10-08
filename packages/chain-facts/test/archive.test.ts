import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMissingHistoricalState } from "../src/resolve.ts";

describe("isMissingHistoricalState", () => {
  it("recognizes the refusal of an RPC that keeps only recent state", () => {
    // #given: the chain's public RPC asked for state 10,000 blocks back
    const error = new Error(
      "historical state be8aaae8b55ea383ebed31517f3b5a3c97e41a3c80b82000d22171d4d0e89703 is not available",
    );
    // #when / #then
    assert.equal(isMissingHistoricalState(error), true);
  });

  it("leaves every other failure alone", () => {
    // #given
    const error = new Error("execution reverted");
    // #when / #then
    assert.equal(isMissingHistoricalState(error), false);
  });
});
