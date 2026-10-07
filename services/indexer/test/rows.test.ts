import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type Hex, type Log } from "viem";
import { MissingBlockTime } from "../src/errors.ts";
import { toRows } from "../src/rows.ts";

const MARKET = "0x00000000000000000000000000000000000000aa";
const OWNER = "0x00000000000000000000000000000000000000bb";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const TX = "0x34f9aa77506ab96c5b8e3e5a9798ffab232533ae61759682c5b091ac4efb4a4f";
const SERIES = 2n ** 255n + 12345n;

function log(encoded: readonly (Hex | Hex[] | null)[], data: Hex, logIndex: number): Log {
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

function orderPlaced(): Log {
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

function batchFilled(): Log {
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

describe("toRows", () => {
  it("files an order event under its order ID and owner", () => {
    // #when
    const [row] = toRows([orderPlaced()], times);
    // #then
    assert.deepEqual(
      [row?.name, row?.order_id, row?.account, row?.series, row?.block_time],
      ["OrderPlaced", "5", OWNER, null, "2026-10-02T20:00:00.000Z"],
    );
  });

  it("keeps a 256-bit series ID exact as a decimal string", () => {
    // #when
    const [row] = toRows([batchFilled()], times);
    // #then
    assert.deepEqual(
      [row?.series, row?.order_id, row?.args["premiumValue"]],
      [SERIES.toString(), "5", "2500000"],
    );
  });

  it("refuses a log whose block time it doesn't have", () => {
    // #when
    const decode = (): unknown => toRows([orderPlaced()], new Map());
    // #then
    assert.throws(decode, MissingBlockTime);
  });
});
