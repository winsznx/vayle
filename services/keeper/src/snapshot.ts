import { sessionCalendarAbi, vayleMarketAbi } from "@vayle/abi";
import type { PublicClient } from "viem";
import type { KeeperConfig } from "./config.ts";
import { roundHint } from "./hint.ts";
import type {
  BatchPhase,
  Boundary,
  BucketView,
  EpochView,
  OrderStatus,
  OrderView,
  SeriesView,
  Snapshot,
} from "./plan.ts";

// Orders are read for this long after each close: settlement and the batch both fall inside it.
export const ORDERS_AFTER_CLOSE = 3 * 86_400;
const READ_BATCH = 20;

// OrderStatus in the contract: None, Active, Cancelled, Closed. None never comes back for a real ID.
const STATUS: readonly OrderStatus[] = ["closed", "active", "cancelled", "closed"];
const PHASES: readonly BatchPhase[] = ["none", "counting", "filling", "done"];

async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(read))));
  }
  return results;
}

export async function readSnapshot(client: PublicClient, config: KeeperConfig): Promise<Snapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const calendar = { address: config.calendar, abi: sessionCalendarAbi, blockNumber } as const;
  const [lookback, bidWindow, latestExpiry, count] = await Promise.all([
    client.readContract({ ...market, functionName: "LIVENESS_LOOKBACK" }),
    client.readContract({ ...market, functionName: "BID_WINDOW" }),
    client.readContract({ ...market, functionName: "latestExpiry", args: [config.asset] }),
    client.readContract({ ...calendar, functionName: "boundaryCount" }),
  ]);

  let latestBoundary: Boundary | null = null;
  let nextClose: number | null = null;
  for (let index = count; index > 0n; index--) {
    const b = await client.readContract({
      ...calendar,
      functionName: "boundaryAt",
      args: [index - 1n],
    });
    if (Number(b.close) > now) {
      nextClose = Number(b.close);
      continue;
    }
    latestBoundary = { close: Number(b.close), creationDeadline: Number(b.creationDeadline) };
    break;
  }

  let epoch: EpochView | null = null;
  if (latestExpiry !== 0n) {
    const e = await client.readContract({
      ...market,
      functionName: "epoch",
      args: [config.asset, latestExpiry],
    });
    epoch = {
      opening: Number(e.opening),
      expiry: Number(e.expiry),
      batchDeadline: Number(e.batchDeadline),
      windowLength: e.windowLength,
    };
  }
  const epochAtLatest =
    epoch !== null && latestBoundary !== null && epoch.opening === latestBoundary.close;
  const due =
    latestBoundary !== null &&
    !epochAtLatest &&
    now > latestBoundary.close &&
    now < latestBoundary.creationDeadline;
  const hint =
    due && latestBoundary !== null
      ? await roundHint(client, config.feed, latestBoundary.close)
      : null;

  const readOrders =
    latestBoundary !== null &&
    now >= latestBoundary.close &&
    now < latestBoundary.close + ORDERS_AFTER_CLOSE;
  const orders = readOrders ? await readAllOrders(client, config, blockNumber) : null;
  const series = orders === null ? [] : await readSeries(client, config, blockNumber, orders);
  const buckets =
    orders === null || epoch === null
      ? []
      : await readBuckets(client, config, blockNumber, orders, epoch);

  return {
    now,
    asset: config.asset,
    lookback: Number(lookback),
    bidWindow: Number(bidWindow),
    latestBoundary,
    nextClose,
    epoch,
    epochAtLatest,
    roundHint: hint,
    series,
    orders,
    buckets,
  };
}

async function readAllOrders(
  client: PublicClient,
  config: KeeperConfig,
  blockNumber: bigint,
): Promise<OrderView[]> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const count = await client.readContract({ ...market, functionName: "orderCount" });
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const orders = await inBatches(ids, async (id) => {
    const o = await client.readContract({ ...market, functionName: "orderOf", args: [id] });
    return { id, o };
  });
  return orders
    .filter(({ o }) => o.asset === config.asset)
    .map(({ id, o }) => ({
      id,
      side: o.side,
      target: o.target,
      status: STATUS[o.status] ?? "closed",
      series: o.series,
      minPremium: o.minPremium,
    }));
}

async function readSeries(
  client: PublicClient,
  config: KeeperConfig,
  blockNumber: bigint,
  orders: readonly OrderView[],
): Promise<SeriesView[]> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const ids = [...new Set(orders.filter((o) => o.series !== 0n).map((o) => o.series))];
  return inBatches(ids, async (id) => {
    const [key, windowEnd, pool] = await Promise.all([
      client.readContract({ ...market, functionName: "seriesKey", args: [id] }),
      client.readContract({ ...market, functionName: "windowEnd", args: [id] }),
      client.readContract({ ...market, functionName: "poolOf", args: [id] }),
    ]);
    return { id, expiry: Number(key.expiry), windowEnd: Number(windowEnd), settled: pool.settled };
  });
}

async function readBuckets(
  client: PublicClient,
  config: KeeperConfig,
  blockNumber: bigint,
  orders: readonly OrderView[],
  epoch: EpochView,
): Promise<BucketView[]> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const seen = new Map<string, { side: number; target: bigint }>();
  for (const o of orders) {
    if (o.status === "active" && o.series === 0n) {
      seen.set(`${o.side}:${o.target.toString()}`, { side: o.side, target: o.target });
    }
  }
  const expiry = BigInt(epoch.expiry);
  const buckets = await inBatches([...seen.values()], async ({ side, target }) => {
    const listed = await client.readContract({
      ...market,
      functionName: "isListedStrike",
      args: [config.asset, expiry, side, target],
    });
    if (!listed) return null;
    // An eth_call of seriesFor returns the ID whether or not the series is registered yet.
    const { result: series } = await client.simulateContract({
      address: config.market,
      abi: vayleMarketAbi,
      functionName: "seriesFor",
      args: [config.asset, expiry, side, target],
      blockNumber,
    });
    const [bid, batch, attached] = await Promise.all([
      client.readContract({ ...market, functionName: "bestBid", args: [series] }),
      client.readContract({ ...market, functionName: "batchOf", args: [series] }),
      client.readContract({
        ...market,
        functionName: "attachedOrders",
        args: [config.asset, side, target],
      }),
    ]);
    const bucket: BucketView = {
      series,
      side,
      target,
      bidPremium: bid.maker === "0x0000000000000000000000000000000000000000" ? null : bid.premium,
      phase: PHASES[batch.phase] ?? "done",
      cursor: batch.cursor,
      maxOrderId: batch.maxOrderId,
      attached,
    };
    return bucket;
  });
  return buckets.filter((b): b is BucketView => b !== null);
}
