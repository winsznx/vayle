import assert from "node:assert/strict";
import { describe, it } from "node:test";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { getAddress } from "viem";
import { bucketKeys } from "../src/snapshot.ts";

const CONFIG = {
  chainId: facts.chain.chainId,
  asset: getAddress(facts.nvda.address),
  usdg: getAddress(facts.usdg.address),
};
// The week ending at the Oct 16, 2026 close, with its two-hour window.
const WEEK = { expiry: 1_792_180_800, windowLength: 7200 };
const SELL_AT_245 = { side: 0, target: 245_000_000n };
const BUY_AT_230 = { side: 1, target: 230_000_000n };

describe("bucketKeys", () => {
  it("reads each side and target once", () => {
    // #given: two sells at $245 and a buy at $230
    const orders = [SELL_AT_245, SELL_AT_245, BUY_AT_230];
    // #when
    const keys = bucketKeys(orders, WEEK, CONFIG);
    // #then
    assert.deepEqual(
      keys.map(({ side, strike }) => [side, strike]),
      [
        [0, 245_000_000n],
        [1, 230_000_000n],
      ],
    );
  });

  it("works out the series IDs the market gives these terms", () => {
    // #given: the IDs the market registered for a $245 call and a $230 put that week, which
    // don't depend on the market's address
    const call = 6730551042281658524990364716284180930003331497979158362436015311512157505391n;
    const put = 112950208447607718745742238145588434431959083132519865902148499795964009097365n;
    // #when
    const keys = bucketKeys([SELL_AT_245, BUY_AT_230], WEEK, CONFIG);
    // #then
    assert.deepEqual(
      keys.map(({ series }) => series),
      [call, put],
    );
  });
});
