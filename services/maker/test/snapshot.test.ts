import assert from "node:assert/strict";
import { describe, it } from "node:test";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { getAddress } from "viem";
import { bucketKeys, listedTargets } from "../src/snapshot.ts";

const CHAIN = { chainId: facts.chain.chainId, usdg: getAddress(facts.usdg.address) };
const NVDA = getAddress(facts.nvda.address);
// The week ending at the Oct 16, 2026 close, with its two-hour window.
const WEEK = { expiry: 1_792_180_800, windowLength: 7200 };
const SELL_AT_245 = { side: 0, target: 245_000_000n };
const BUY_AT_230 = { side: 1, target: 230_000_000n };

describe("bucketKeys", () => {
  it("reads each side and target once", () => {
    // #given: two sells at $245 and a buy at $230
    const orders = [SELL_AT_245, SELL_AT_245, BUY_AT_230];
    // #when
    const keys = bucketKeys(orders, WEEK, NVDA, CHAIN);
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
    const keys = bucketKeys([SELL_AT_245, BUY_AT_230], WEEK, NVDA, CHAIN);
    // #then
    assert.deepEqual(
      keys.map(({ series }) => series),
      [call, put],
    );
  });
});

describe("listedTargets", () => {
  // The Oct 2 close's reference, $234.997119, a $5 strike tick and a 10% band.
  const GRID = { referencePrice: 234_997_119n, strikeTick: 5_000_000n, strikeRangeBps: 1000 };

  it("lists sell targets above the reference, within the band, on the tick", () => {
    // #when
    const targets = listedTargets(GRID, 0);
    // #then: up to $258.496830
    assert.deepEqual(targets, [
      235_000_000n,
      240_000_000n,
      245_000_000n,
      250_000_000n,
      255_000_000n,
    ]);
  });

  it("lists buy targets below the reference, within the band, on the tick", () => {
    // #when
    const targets = listedTargets(GRID, 1);
    // #then: down to $211.497408
    assert.deepEqual(targets, [215_000_000n, 220_000_000n, 225_000_000n, 230_000_000n]);
  });

  it("leaves out a target on the reference itself", () => {
    // #given: a reference exactly on the tick
    const grid = { ...GRID, referencePrice: 240_000_000n };
    // #when
    const targets = [listedTargets(grid, 0), listedTargets(grid, 1)];
    // #then
    assert.deepEqual(targets, [
      [245_000_000n, 250_000_000n, 255_000_000n, 260_000_000n],
      [220_000_000n, 225_000_000n, 230_000_000n, 235_000_000n],
    ]);
  });
});
