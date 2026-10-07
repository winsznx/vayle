import { vayleMarketAbi } from "@vayle/abi";
import { parseEventLogs, type Address, type Log, type PublicClient } from "viem";

// The market's events, decoded the same way wherever they're read: by the indexer before it stores
// them, and by the app straight from the chain when no indexer is configured. Order and series IDs
// are decimal strings, since series IDs are 256-bit and JSON numbers would round them.

export interface MarketEvent {
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

export class MissingBlockTime extends Error {
  override readonly name = "MissingBlockTime";
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

// Decodes the market's logs. Logs the ABI doesn't describe are dropped.
export function toMarketEvents(
  logs: readonly Log[],
  blockTimes: ReadonlyMap<bigint, number>,
): MarketEvent[] {
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

// The market's events from `fromBlock` to `toBlock`, read `chunk` blocks at a time, oldest first.
export async function readMarketEvents(
  client: PublicClient,
  market: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 50_000n,
): Promise<MarketEvent[]> {
  const events: MarketEvent[] = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - 1n < toBlock ? from + chunk - 1n : toBlock;
    const logs = await client.getLogs({ address: market, fromBlock: from, toBlock: to });
    const numbers = [...new Set(logs.map((l) => l.blockNumber))];
    const times = new Map(
      await Promise.all(
        numbers.map(async (n) => {
          const block = await client.getBlock({ blockNumber: n });
          return [n, Number(block.timestamp)] as const;
        }),
      ),
    );
    events.push(...toMarketEvents(logs, times));
  }
  return events;
}

// What an order card shows, worked out from the order's events.

export interface Week {
  readonly opening: number;
  readonly expiry: number;
}

export type HistoryState = "active" | "cancelled" | "closed";

export interface OrderSummary {
  readonly id: string;
  readonly state: HistoryState;
  // USDG base units, as a decimal string.
  readonly premiumEarned: string;
  readonly weeksFilled: number;
  readonly skipStreak: number;
}

// A week counts once its batch deadline has passed, which is under 3 days after its opening.
export const WEEK_SETTLES_AFTER = 3 * 86_400;
// An order placed before the batch opens, 4 hours after the opening, can join that week's batch.
export const BATCH_OPENS_AFTER = 4 * 3600;

function seconds(isoTime: string): number {
  return Math.floor(Date.parse(isoTime) / 1000);
}

function text(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" ? value : null;
}

export function weeksOf(epochEvents: readonly MarketEvent[]): Week[] {
  return epochEvents
    .filter((e) => e.name === "EpochCreated")
    .map((e) => ({
      opening: Number(text(e.args, "opening") ?? Number.NaN),
      expiry: Number(text(e.args, "expiry") ?? Number.NaN),
    }))
    .filter((w) => Number.isFinite(w.opening) && Number.isFinite(w.expiry));
}

export function seriesExpiries(seriesEvents: readonly MarketEvent[]): Map<string, number> {
  const expiries = new Map<string, number>();
  for (const e of seriesEvents) {
    const key = e.args["key"];
    if (e.name !== "SeriesRegistered" || e.series === null) continue;
    if (typeof key !== "object" || key === null || !("expiry" in key)) continue;
    expiries.set(e.series, Number(key.expiry));
  }
  return expiries;
}

export function orderSummary(
  id: string,
  orderEvents: readonly MarketEvent[],
  weeks: readonly Week[],
  expiries: ReadonlyMap<string, number>,
  now: number,
): OrderSummary {
  const own = orderEvents.filter((e) => e.order_id === id);
  const state: HistoryState = own.some((e) => e.name === "OrderClosed")
    ? "closed"
    : own.some((e) => e.name === "OrderCancelled")
      ? "cancelled"
      : "active";
  const fills = own.filter((e) => e.name === "QuoteFilled" || e.name === "BatchFilled");
  const premiumEarned = fills.reduce(
    (sum, e) => sum + BigInt(text(e.args, "premiumValue") ?? "0"),
    0n,
  );
  const filledExpiries = new Set(
    fills.flatMap((e) => {
      const expiry = e.series === null ? undefined : expiries.get(e.series);
      return expiry === undefined ? [] : [expiry];
    }),
  );
  const placed = own.find((e) => e.name === "OrderPlaced");
  const placedAt = placed === undefined ? Number.POSITIVE_INFINITY : seconds(placed.block_time);
  const counted = weeks
    .filter((w) => w.opening + WEEK_SETTLES_AFTER <= now)
    .filter((w) => filledExpiries.has(w.expiry) || placedAt < w.opening + BATCH_OPENS_AFTER)
    .sort((a, b) => b.opening - a.opening);
  let skipStreak = 0;
  if (state === "active") {
    for (const w of counted) {
      if (filledExpiries.has(w.expiry)) break;
      skipStreak++;
    }
  }
  return {
    id,
    state,
    premiumEarned: premiumEarned.toString(),
    weeksFilled: filledExpiries.size,
    skipStreak,
  };
}
