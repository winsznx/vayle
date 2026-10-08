import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectoryFeed } from "@vayle/chain-facts/sources";
import { zeroAddress, type Address, type Hex } from "viem";
import {
  judgeErc8056,
  judgeFeed,
  judgeMultiplier,
  judgePauses,
  judgeUid,
  type FeedReads,
} from "../src/checks.ts";
import type { Read } from "../src/rpc.ts";

const PROXY: Address = "0x1111111111111111111111111111111111111111";
const AGGREGATOR: Address = "0x2222222222222222222222222222222222222222";
const CONTROLLER: Address = "0x3333333333333333333333333333333333333333";

const LISTING: DirectoryFeed = {
  name: "Robinhood TEST / USD",
  proxy: PROXY,
  svrProxy: null,
  aggregator: AGGREGATOR,
  decimals: 8,
  heartbeatSeconds: 86_400,
  deviationThresholdPercent: 0.5,
  marketHours: "us_equities_24/5",
};

function ok<T>(value: T): Read<T> {
  return { ok: true, value };
}

const REVERTED: Read<never> = { ok: false, kind: "reverted", error: "reverted without data" };
const UNAVAILABLE: Read<never> = { ok: false, kind: "unavailable", error: "HttpRequestError" };

const FEED: FeedReads = {
  accessController: ok(zeroAddress),
  decimals: ok(8),
  aggregator: ok(AGGREGATOR),
  latestRound: ok({ roundId: (1n << 64n) | 5n, answer: 24_000_000_000n, updatedAt: 1 }),
};

describe("judgeFeed", () => {
  it("passes a listed feed anyone can read that matches the directory", () => {
    // #given
    const reads = FEED;
    // #when
    const check = judgeFeed(LISTING, reads);
    // #then
    assert.deepEqual(check, {
      status: "pass",
      reason: "",
      proxy: PROXY,
      heartbeatSeconds: 86_400,
      deviationThresholdPercent: 0.5,
      marketHours: "us_equities_24/5",
    });
  });

  it("passes a proxy that has no accessController() at all", () => {
    // #given
    const reads = { ...FEED, accessController: REVERTED };
    // #when
    const check = judgeFeed(LISTING, reads);
    // #then
    assert.equal(check.status, "pass");
  });

  it("fails a proxy with an access controller", () => {
    // #given
    const reads = { ...FEED, accessController: ok(CONTROLLER) };
    // #when
    const check = judgeFeed(LISTING, reads);
    // #then
    assert.deepEqual(
      [check.status, check.reason],
      ["fail", `the proxy's accessController() is ${CONTROLLER}`],
    );
  });

  it("fails a proxy whose decimals or aggregator differ from the directory", () => {
    // #given
    const reads = { ...FEED, decimals: ok(18), aggregator: ok(CONTROLLER) };
    // #when
    const check = judgeFeed(LISTING, reads);
    // #then
    assert.deepEqual(
      [check.status, check.reason],
      [
        "fail",
        `the proxy reports 18 decimals, the directory 8; the proxy reads aggregator ${CONTROLLER}, the directory ${AGGREGATOR}`,
      ],
    );
  });

  it("fails a feed whose latest answer isn't positive", () => {
    // #given
    const reads = { ...FEED, latestRound: ok({ roundId: 1n, answer: 0n, updatedAt: 1 }) };
    // #when
    const check = judgeFeed(LISTING, reads);
    // #then
    assert.deepEqual([check.status, check.reason], ["fail", "the latest answer is 0"]);
  });

  it("fails a token with no listed feed", () => {
    // #given
    const listing = "the feed directory lists DELL: 0 tokenized price feeds, expected 1";
    // #when
    const check = judgeFeed(listing, null);
    // #then
    assert.deepEqual([check.status, check.proxy], ["fail", null]);
  });

  it("doesn't run when a read couldn't be made", () => {
    // #given
    const reads = { ...FEED, decimals: UNAVAILABLE };
    // #when
    const check = judgeFeed(LISTING, reads);
    // #then
    assert.deepEqual([check.status, check.reason], ["not_run", "decimals(): HttpRequestError"]);
  });
});

describe("judgeErc8056", () => {
  it("passes core, balances and pending without conversion", () => {
    // #given
    const reads = { core: ok(true), balances: ok(true), pending: ok(true), conversion: ok(false) };
    // #when
    const check = judgeErc8056(reads);
    // #then
    assert.deepEqual(check, {
      status: "pass",
      reason: "",
      core: true,
      balances: true,
      pending: true,
      conversion: false,
    });
  });

  it("fails without the balances interface", () => {
    // #given
    const reads = { core: ok(true), balances: ok(false), pending: ok(true), conversion: ok(true) };
    // #when
    const check = judgeErc8056(reads);
    // #then
    assert.deepEqual(
      [check.status, check.reason],
      ["fail", "the balances interface isn't supported"],
    );
  });

  it("fails a token whose supportsInterface reverts", () => {
    // #given
    const reads = { core: REVERTED, balances: REVERTED, pending: REVERTED, conversion: REVERTED };
    // #when
    const check = judgeErc8056(reads);
    // #then
    assert.deepEqual([check.status, check.core], ["fail", null]);
  });
});

describe("judgeMultiplier", () => {
  const NOW = 1_800_000_000;

  it("passes when no different multiplier is pending", () => {
    // #given
    const reads = {
      uiMultiplier: ok(10n),
      newUIMultiplier: ok(10n),
      effectiveAt: ok(2_000_000_000n),
    };
    // #when
    const check = judgeMultiplier(reads, NOW);
    // #then
    assert.equal(check.status, "pass");
  });

  it("passes a different multiplier whose time has come", () => {
    // #given
    const reads = { uiMultiplier: ok(10n), newUIMultiplier: ok(11n), effectiveAt: ok(BigInt(NOW)) };
    // #when
    const check = judgeMultiplier(reads, NOW);
    // #then
    assert.equal(check.status, "pass");
  });

  it("fails a different multiplier that takes effect later", () => {
    // #given
    const reads = {
      uiMultiplier: ok(10n),
      newUIMultiplier: ok(40n),
      effectiveAt: ok(BigInt(NOW + 1)),
    };
    // #when
    const check = judgeMultiplier(reads, NOW);
    // #then
    assert.deepEqual(check, {
      status: "fail",
      reason: `a multiplier of 40 replaces 10 at ${NOW + 1}`,
      uiMultiplier: "10",
      newUIMultiplier: "40",
      effectiveAt: NOW + 1,
    });
  });
});

describe("judgePauses", () => {
  it("passes when nothing is paused", () => {
    // #given
    const reads = { oraclePaused: ok(false), paused: ok(false), registryPaused: ok(false) };
    // #when
    const check = judgePauses(reads);
    // #then
    assert.deepEqual(check, {
      status: "pass",
      reason: "",
      oraclePaused: false,
      paused: false,
      registryPaused: false,
    });
  });

  it("fails a paused oracle and a paused access registry", () => {
    // #given
    const reads = { oraclePaused: ok(true), paused: ok(false), registryPaused: ok(true) };
    // #when
    const check = judgePauses(reads);
    // #then
    assert.deepEqual(
      [check.status, check.reason],
      ["fail", "oraclePaused() is true; the token's access registry is paused"],
    );
  });
});

describe("judgeUid", () => {
  const ID: Hex = "0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5";

  it("matches uid() to the registry id whatever the hex case", () => {
    // #given
    const reads = { uid: ok(ID), decimals: ok(18) };
    // #when
    const check = judgeUid(reads, ID.toUpperCase().replace("0X", "0x"), 18);
    // #then
    assert.deepEqual(check, { status: "pass", reason: "" });
  });

  it("fails a uid() that isn't the registry's", () => {
    // #given
    const other: Hex = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const reads = { uid: ok(other), decimals: ok(18) };
    // #when
    const check = judgeUid(reads, ID, 18);
    // #then
    assert.deepEqual(check, {
      status: "fail",
      reason: `uid() ${other} differs from the registry id ${ID}`,
    });
  });

  it("fails decimals() that aren't the registry's", () => {
    // #given
    const reads = { uid: ok(ID), decimals: ok(6) };
    // #when
    const check = judgeUid(reads, ID, 18);
    // #then
    assert.deepEqual(check, { status: "fail", reason: "decimals() 6, the registry 18" });
  });
});
