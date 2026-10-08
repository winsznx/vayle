import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Hex, type Log } from "viem";
import {
  blockTimesInLogs,
  MissingBlockTime,
  orderSummary,
  toMarketEvents,
  type MarketEvent,
  type Week,
  weekSettlesAt,
  weeksOf,
} from "../src/history.ts";

const MARKET = "0x00000000000000000000000000000000000000aa";
const OWNER = "0x00000000000000000000000000000000000000bb";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const TX = "0x34f9aa77506ab96c5b8e3e5a9798ffab232533ae61759682c5b091ac4efb4a4f";
const SERIES = 2n ** 255n + 12345n;

function log(
  encoded: readonly (Hex | Hex[] | null)[],
  data: Hex,
  logIndex: number,
): Log<bigint, number, false> {
  const topics = encoded.filter((t): t is Hex => typeof t === "string");
  const [signature, ...rest] = topics;
  if (signature === undefined) throw new Error("an event log needs its signature topic");
  return {
    address: MARKET,
    topics: [signature, ...rest],
    data,
    blockNumber: 82_000_000n,
    blockHash: TX,
    transactionHash: TX,
    transactionIndex: 0,
    logIndex,
    removed: false,
  };
}

function orderPlaced(): Log<bigint, number, false> {
  const event = getAbiItem({ abi: vayleMarketAbi, name: "OrderPlaced" });
  const topics = encodeEventTopics({
    abi: [event],
    eventName: "OrderPlaced",
    args: { id: 5n, owner: OWNER, asset: NVDA },
  });
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    [0, 245_000_000n, 1_000n, 10n ** 18n, false, 0n],
  );
  return log(topics, data, 1);
}

function batchFilled(): Log<bigint, number, false> {
  const event = getAbiItem({ abi: vayleMarketAbi, name: "BatchFilled" });
  const topics = encodeEventTopics({
    abi: [event],
    eventName: "BatchFilled",
    args: { series: SERIES, orderId: 5n },
  });
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    [10n ** 18n, 2_500_000n],
  );
  return log(topics, data, 2);
}

const times = new Map([[82_000_000n, 1_790_971_200]]);

describe("toMarketEvents", () => {
  it("files an order event under its order ID and owner", () => {
    // #when
    const [row] = toMarketEvents([orderPlaced()], times);
    // #then
    assert.deepEqual(
      [row?.name, row?.order_id, row?.account, row?.series, row?.block_time],
      ["OrderPlaced", "5", OWNER, null, "2026-10-02T20:00:00.000Z"],
    );
  });

  it("keeps a 256-bit series ID exact as a decimal string", () => {
    // #when
    const [row] = toMarketEvents([batchFilled()], times);
    // #then
    assert.deepEqual(
      [row?.series, row?.order_id, row?.args["premiumValue"]],
      [SERIES.toString(), "5", "2500000"],
    );
  });

  it("refuses a log whose block time it doesn't have", () => {
    // #when
    const decode = (): unknown => toMarketEvents([orderPlaced()], new Map());
    // #then
    assert.throws(decode, MissingBlockTime);
  });
});

describe("blockTimesInLogs", () => {
  it("takes each block's time from the timestamp on its logs", () => {
    // #given
    const blockTimestamp = 1_790_971_200n;
    const logs = [
      { ...orderPlaced(), blockTimestamp },
      { ...batchFilled(), blockTimestamp },
    ];
    // #when
    const { times, missing } = blockTimesInLogs(logs);
    // #then
    assert.deepEqual([[...times], missing], [[[82_000_000n, 1_790_971_200]], []]);
  });

  it("leaves a block to look up once when its logs arrive without a timestamp", () => {
    // #when
    const { times, missing } = blockTimesInLogs([orderPlaced(), batchFilled()]);
    // #then
    assert.deepEqual([times.size, missing], [0, [82_000_000n]]);
  });
});

const DAY = 86_400;
// Four weekly openings, Fridays 16:00 ET.
const W1 = 1_789_761_600;
const weeks: Week[] = [0, 1, 2, 3].map((k) => ({
  opening: W1 + k * 7 * DAY,
  expiry: W1 + (k + 1) * 7 * DAY,
}));

function event(name: string, order: string, extra: Partial<MarketEvent> = {}): MarketEvent {
  return {
    block_number: 1,
    log_index: 0,
    tx_hash: "0x",
    block_time: new Date((W1 - DAY) * 1000).toISOString(),
    name,
    order_id: order,
    series: null,
    account: null,
    args: {},
    ...extra,
  };
}

function fill(order: string, series: string, premium: string): MarketEvent {
  return event("BatchFilled", order, { series, args: { premiumValue: premium } });
}

// Series 1 expires at the end of week 1, series 2 at the end of week 2.
const expiries = new Map([
  ["1", weeks[0]?.expiry ?? 0],
  ["2", weeks[1]?.expiry ?? 0],
]);
// After week 4's batch deadline.
const NOW = W1 + 3 * 7 * DAY + 4 * DAY;

describe("orderSummary", () => {
  it("adds up premium and counts the weeks that filled", () => {
    // #given
    const events = [
      event("OrderPlaced", "5"),
      fill("5", "1", "2500000"),
      fill("5", "2", "1250000"),
    ];
    // #when
    const summary = orderSummary("5", events, weeks, expiries, NOW);
    // #then
    assert.deepEqual(
      [summary.premiumEarned, summary.weeksFilled, summary.state],
      ["3750000", 2, "active"],
    );
  });

  it("counts the weeks in a row without a fill since the last one", () => {
    // #given: filled in weeks 1 and 2, nothing in weeks 3 and 4
    const events = [event("OrderPlaced", "5"), fill("5", "1", "1"), fill("5", "2", "1")];
    // #when
    const summary = orderSummary("5", events, weeks, expiries, NOW);
    // #then
    assert.equal(summary.skipStreak, 2);
  });

  it("doesn't count a week the order joined after its batch had run", () => {
    // #given: placed on the Wednesday of week 3, never filled
    const placed = event("OrderPlaced", "6", {
      block_time: new Date((W1 + 2 * 7 * DAY + 5 * DAY) * 1000).toISOString(),
    });
    // #when
    const summary = orderSummary("6", [placed], weeks, expiries, NOW);
    // #then: only week 4 counts
    assert.equal(summary.skipStreak, 1);
  });

  it("shows no streak for an order that isn't active", () => {
    // #given
    const events = [event("OrderPlaced", "5"), event("OrderCancelled", "5")];
    // #when
    const summary = orderSummary("5", events, weeks, expiries, NOW);
    // #then
    assert.deepEqual([summary.state, summary.skipStreak], ["cancelled", 0]);
  });
});

describe("weekSettlesAt", () => {
  it("counts a Friday week 3 days after its close, well past its Sunday batch deadline", () => {
    // #given Fri Oct 9 2026, 16:00 EDT
    const opening = 1_791_576_000;
    // #when
    const settles = weekSettlesAt(opening);
    // #then
    assert.equal(settles, opening + 3 * 86_400);
  });

  it("waits for a Thursday close's batch, whose deadline is more than 3 days out", () => {
    // #given Thu Dec 24 2026, 13:00 EST, before the Christmas holiday
    const opening = 1_798_135_200;
    // #when
    const settles = weekSettlesAt(opening);
    // #then the batch deadline, Sun Dec 27 20:00 EST, and an hour more
    assert.equal(settles, 1_798_419_600 + 3600);
  });
});

describe("weeksOf", () => {
  function epoch(asset: string, opening: number, expiry: number): MarketEvent {
    return {
      block_number: 1,
      log_index: 0,
      tx_hash: TX,
      block_time: "2026-10-09T20:05:00Z",
      name: "EpochCreated",
      order_id: null,
      series: null,
      account: null,
      args: { asset, opening: String(opening), expiry: String(expiry) },
    };
  }

  it("keeps only the asset's own weeks, whatever the letter case of its address", () => {
    // #given: two markets opened the same week
    const spy = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";
    const events = [epoch(NVDA, 100, 200), epoch(spy, 100, 200), epoch(NVDA, 200, 300)];
    // #when
    const weeks = weeksOf(events, NVDA.toLowerCase());
    // #then
    assert.deepEqual(weeks, [
      { opening: 100, expiry: 200 },
      { opening: 200, expiry: 300 },
    ]);
  });
});
