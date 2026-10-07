import { vayleMarketAbi } from "@vayle/abi";
import { parseEventLogs, type Log } from "viem";
import { MissingBlockTime } from "./errors.ts";

// One market event as stored: where it happened, what it was, and the IDs the API filters by.
export interface EventRow {
  readonly block_number: number;
  readonly log_index: number;
  readonly tx_hash: string;
  readonly block_time: string;
  readonly name: string;
  readonly order_id: string | null;
  readonly series: string | null;
  readonly account: string | null;
  readonly args: Readonly<Record<string, unknown>>;
}

// The argument holding each kind of ID, per event. Events not listed carry none of that kind.
const ORDER_ARG: Readonly<Record<string, string>> = {
  OrderPlaced: "id",
  OrderUpdated: "id",
  OrderCancelled: "id",
  OrderClosed: "id",
  OrderCommitted: "id",
  OrderSettled: "id",
  OrderSkipped: "orderId",
  BatchFilled: "orderId",
  QuoteFilled: "orderId",
  OrderFlipped: "fromId",
};
const SERIES_ARG: Readonly<Record<string, string>> = {
  OrderCommitted: "series",
  OrderSettled: "series",
  OrderSkipped: "series",
  BatchFilled: "series",
  QuoteFilled: "series",
  SeriesRegistered: "id",
  SeriesFinalized: "series",
  Exercised: "series",
  BidSubmitted: "series",
  BatchOpened: "series",
  BatchSealed: "series",
  BatchDone: "series",
};
const ACCOUNT_ARG: Readonly<Record<string, string>> = {
  OrderPlaced: "owner",
  Credited: "owner",
  Withdrawn: "owner",
  Exercised: "exerciser",
  QuoteFilled: "maker",
  BidSubmitted: "maker",
  BatchOpened: "maker",
  TeamOperatedSet: "maker",
  NoncesInvalidated: "maker",
  QuoteCancelled: "maker",
};

// Integers become decimal strings, so no precision is lost in JSON.
export function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function idArg(args: Readonly<Record<string, unknown>>, name: string | undefined): string | null {
  if (name === undefined) return null;
  const value = args[name];
  return typeof value === "string" ? value : null;
}

// Decodes the market's logs into rows. Logs the ABI doesn't describe are dropped.
export function toRows(logs: readonly Log[], blockTimes: ReadonlyMap<bigint, number>): EventRow[] {
  return parseEventLogs({ abi: vayleMarketAbi, logs: [...logs] }).map((log) => {
    const args = plain(log.args) as Readonly<Record<string, unknown>>;
    const account = idArg(args, ACCOUNT_ARG[log.eventName]);
    const time = blockTimes.get(log.blockNumber);
    if (time === undefined)
      throw new MissingBlockTime(`no time for block ${log.blockNumber.toString()}`);
    return {
      block_number: Number(log.blockNumber),
      log_index: log.logIndex,
      tx_hash: log.transactionHash,
      block_time: new Date(time * 1000).toISOString(),
      name: log.eventName,
      order_id: idArg(args, ORDER_ARG[log.eventName]),
      series: idArg(args, SERIES_ARG[log.eventName]),
      account: account?.toLowerCase() ?? null,
      args,
    };
  });
}
