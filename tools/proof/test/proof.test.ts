import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarketEvent } from "@vayle/market";
import { countsOf, transactionsOf, walletsOf } from "../src/proof.ts";
import { forgeCounts, nodeCounts } from "../src/ci.ts";

const TEAM = [{ address: "0xC45716eD08999073fd60a00373fe63485555F1a8", label: "Team test wallet" }];

function event(
  name: string,
  tx: string,
  block: number,
  logIndex: number,
  account: string | null,
): MarketEvent {
  return {
    block_number: block,
    log_index: logIndex,
    tx_hash: tx,
    block_time: "2026-10-13T02:00:00.000Z",
    name,
    order_id: null,
    series: null,
    account,
    args: {},
  };
}

const outside = "0x00000000000000000000000000000000000000aa";
const events = [
  event("OrderPlaced", "0x01", 10, 0, TEAM[0]?.address.toLowerCase() ?? null),
  event("QuoteFilled", "0x02", 11, 1, "0x5cf1b3a1041ad0cd66315a8915eb4be03e7fae10"),
  event("OrderCommitted", "0x02", 11, 0, null),
  event("OrderPlaced", "0x03", 12, 0, outside),
];

describe("transactionsOf", () => {
  it("lists each transaction once, newest first, with its events in log order and team labels", () => {
    // #when
    const txs = transactionsOf(events, TEAM);
    // #then
    assert.deepEqual(
      txs.map((t) => [t.hash, t.events, t.team]),
      [
        ["0x03", ["OrderPlaced"], null],
        ["0x02", ["OrderCommitted", "QuoteFilled"], null],
        ["0x01", ["OrderPlaced"], "Team test wallet"],
      ],
    );
  });
});

describe("owner transactions", () => {
  it("labels a transaction of only owner settings as the owner's, not the address an event names", () => {
    // #given: the deploy's setup flags the maker, whose address the event carries
    const setup = [
      event("CapsSet", "0x09", 5, 0, null),
      event("TeamOperatedSet", "0x09", 5, 1, "0x5cf1b3a1041ad0cd66315a8915eb4be03e7fae10"),
    ];
    // #when
    const [tx] = transactionsOf(setup, TEAM);
    // #then
    assert.deepEqual([tx?.account, tx?.team], [null, "Owner, through the timelock"]);
  });
});

describe("walletsOf", () => {
  it("counts the wallets that set targets and leaves the team's out of the outside count", () => {
    // #when
    const wallets = walletsOf(events, TEAM);
    // #then
    assert.deepEqual(wallets, { total: 2, team: 1, outside: 1, outsideAddresses: [outside] });
  });
});

describe("countsOf", () => {
  it("counts each event by name", () => {
    // #when / #then
    assert.deepEqual(countsOf(events), { OrderPlaced: 2, QuoteFilled: 1, OrderCommitted: 1 });
  });
});

describe("CI counts", () => {
  it("sums forge's summary lines and node's pass and fail lines", () => {
    // #given
    const log = [
      "Ran 27 test suites in 40.2s (300s CPU time): 347 tests passed, 0 failed, 0 skipped (347 total tests)",
      "Ran 3 test suites in 38.65s (97.35s CPU time): 3 tests passed, 0 failed, 0 skipped (3 total tests)",
      "ℹ pass 102",
      "ℹ fail 0",
      "ℹ pass 54",
    ].join("\n");
    // #when / #then
    assert.deepEqual(
      [forgeCounts(log), nodeCounts(log)],
      [
        { passed: 350, failed: 0 },
        { passed: 156, failed: 0 },
      ],
    );
  });
});
