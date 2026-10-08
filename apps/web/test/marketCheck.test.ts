import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markets } from "@vayle/markets";
import { notListed, parseMarketCheck } from "../src/app/marketCheck.ts";

const CHAIN = 4663;
const first = markets.at(0);
if (first === undefined) throw new Error("the markets file lists no market");

type Status = "pass" | "fail" | "not_run";

function checks(statuses: Partial<Record<string, Status>> = {}): Record<string, unknown> {
  const keys = ["feed", "erc8056", "multiplier", "pauses", "staleness", "liquidity"];
  return Object.fromEntries(
    keys.map((k) => [k, { status: statuses[k] ?? "pass", reason: `${k} reason`, extra: 1 }]),
  );
}

// Made-up tokens beside the first listed market, in the market check's shape.
function file(tokens: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-07T22:58:00.000Z",
    chainId: CHAIN,
    block: { number: 82_835_060, timestamp: 1_791_413_880 },
    sources: [],
    criteria: {},
    tokens,
    ...overrides,
  };
}

const listed = {
  symbol: first.symbol,
  name: "Listed Stock Token",
  address: first.token.toLowerCase(),
  checks: checks(),
  passed: true,
};
const almost = {
  symbol: "ABC",
  name: "Almost Stock Token",
  address: "0x00000000000000000000000000000000000000cc",
  checks: checks({ liquidity: "fail" }),
  passed: false,
};
const ready = {
  symbol: "XYZ",
  name: "Ready Stock Token",
  address: "0x00000000000000000000000000000000000000dd",
  checks: checks(),
  passed: true,
};
const unchecked = {
  symbol: "DEF",
  name: "Unchecked Stock Token",
  address: "0x00000000000000000000000000000000000000ee",
  checks: checks({ feed: "fail", staleness: "not_run", liquidity: "not_run" }),
  passed: false,
};

describe("parseMarketCheck", () => {
  it("reads each token's checks and when the check ran", () => {
    // #when
    const check = parseMarketCheck(file([almost]), CHAIN);
    // #then
    assert.deepEqual(
      [
        check?.generatedAt,
        check?.block,
        check?.tokens.map((t) => [t.symbol, t.passed, t.checks.map((c) => c.status)]),
      ],
      [
        Date.UTC(2026, 9, 7, 22, 58) / 1000,
        { number: 82_835_060n, timestamp: 1_791_413_880 },
        [["ABC", false, ["pass", "pass", "pass", "pass", "pass", "fail"]]],
      ],
    );
  });

  it("leaves out a token whose entry doesn't parse", () => {
    // #given
    const broken = [{ ...almost, checks: { feed: { status: "maybe" } } }, { symbol: "NOADDR" }];
    // #when
    const check = parseMarketCheck(file([...broken, ready]), CHAIN);
    // #then
    assert.deepEqual(
      check?.tokens.map((t) => t.symbol),
      ["XYZ"],
    );
  });

  it("keeps a check the file adds after the required ones, and drops a token missing one", () => {
    // #given
    const withUid = { ...ready, checks: { ...checks(), uid: { status: "pass", reason: "" } } };
    const missing = { ...almost, checks: { feed: { status: "pass", reason: "" } } };
    // #when
    const check = parseMarketCheck(file([withUid, missing]), CHAIN);
    // #then
    assert.deepEqual(
      check?.tokens.map((t) => [t.symbol, t.checks.map((c) => c.key)]),
      [["XYZ", ["feed", "erc8056", "multiplier", "pauses", "staleness", "liquidity", "uid"]]],
    );
  });

  it("treats a file of another version or another chain as not published", () => {
    // #when
    const results = [
      parseMarketCheck(file([ready], { schemaVersion: 2 }), CHAIN),
      parseMarketCheck(file([ready], { chainId: 1 }), CHAIN),
      parseMarketCheck(null, CHAIN),
    ];
    // #then
    assert.deepEqual(results, [null, null, null]);
  });
});

describe("notListed", () => {
  it("leaves out the live markets and puts the tokens closest to listing first", () => {
    // #given
    const check = parseMarketCheck(file([unchecked, listed, almost, ready]), CHAIN);
    if (check === null) throw new Error("the fixture didn't parse");
    // #when
    const others = notListed(check, markets);
    // #then
    assert.deepEqual(
      others.map((t) => t.symbol),
      ["XYZ", "ABC", "DEF"],
    );
  });
});
