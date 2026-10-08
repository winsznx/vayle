import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UsageError } from "../src/errors.ts";
import { parseOptions, type Options } from "../src/options.ts";

const USDG_DECIMALS = 6;

describe("parseOptions", () => {
  it("defaults the cap to $2,500", () => {
    // #given
    const args: string[] = [];
    // #when
    const options = parseOptions(args, USDG_DECIMALS);
    // #then
    assert.deepEqual(options, { capUsd: 2_500, capUsdBase: 2_500_000_000n });
  });

  it("takes a cap in dollars and cents", () => {
    // #given
    const args = ["--cap-usd", "1000.50"];
    // #when
    const options = parseOptions(args, USDG_DECIMALS);
    // #then
    assert.deepEqual(options, { capUsd: 1_000.5, capUsdBase: 1_000_500_000n });
  });

  it("refuses a cap that isn't a plain positive amount in USDG's decimals", () => {
    // #given
    const caps = ["$100", "-5", "0", "1.0000001", "abc"];
    // #when
    const failures = caps.filter((cap) => {
      try {
        parseOptions(["--cap-usd", cap], USDG_DECIMALS);
        return false;
      } catch (error) {
        return error instanceof UsageError;
      }
    });
    // #then
    assert.deepEqual(failures, caps);
  });

  it("refuses arguments it doesn't know", () => {
    // #given
    const args = ["--cap", "100"];
    // #when
    const parse = (): Options => parseOptions(args, USDG_DECIMALS);
    // #then
    assert.throws(parse, UsageError);
  });
});
