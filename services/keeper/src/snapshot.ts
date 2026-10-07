import { sessionCalendarAbi, vayleMarketAbi } from "@vayle/abi";
import { seriesId } from "@vayle/market";
import { BaseError, ContractFunctionRevertedError, type PublicClient } from "viem";
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

// Orders are read from each close until the week's batch is done. Three days covers settlement and
// a Friday close's batch. A Thursday close's batch deadline falls later, so the read runs to an hour
// past the week's own deadline, which leaves time to finish a sealed batch or close a dead one.
export const ORDERS_AFTER_CLOSE = 3 * 86_400;
export const AFTER_BATCH_DEADLINE = 3_600;

export function ordersReadUntil(close: number, batchDeadline: number | null): number {
  const settled = close + ORDERS_AFTER_CLOSE;
  return batchDeadline === null ? settled : Math.max(settled, batchDeadline + AFTER_BATCH_DEADLINE);
}

// Every read is pinned to the run's block, and reads that don't wait on each other start together,
// so the client sends each group as one Multicall3 call. The order book is the one group that grows
// without bound. orderOf measured about 29,000 gas on the fork, so a full 32 KiB call of them would
// take more than half of the node's 50M gas cap for an eth_call. Orders go in calls of their own
// instead, at most this many each (11.7M gas measured), all sent at once.
export const ORDERS_PER_CALL = 400;
// orderOf's calldata: a 4-byte selector and one 32-byte ID.
const ORDER_OF_BYTES = 36;

// OrderStatus in the contract: None, Active, Cancelled, Closed. None never comes back for a real ID.
const STATUS: readonly OrderStatus[] = ["closed", "active", "cancelled", "closed"];
const PHASES: readonly BatchPhase[] = ["none", "counting", "filling", "done"];

// Whether `error` is a contract revert with this name, wherever viem wrapped it.
export function isRevert(error: unknown, errorName: string): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (e) => e instanceof ContractFunctionRevertedError && e.data?.errorName === errorName,
    ) !== null
  );
}

// The calendar answers "no close" with a named revert. Only that revert means none: any other
// failure is thrown, because a failed read taken for "no next close" would plan no pings.
export function noneOnRevert(errorName: string): (error: unknown) => null {
  return (error) => {
    if (isRevert(error, errorName)) return null;
    throw error;
  };
}

// The ID the market gives the series at a bucket's target in `epoch`, registered or not. These are
// the terms the market hashes: calls are collateralized in the asset and puts in USDG.
export function bucketSeries(
  config: KeeperConfig,
  epoch: EpochView,
  side: number,
  target: bigint,
): bigint {
  return seriesId({
    chainId: BigInt(config.chainId),
    asset: config.asset,
    side,
    strike: target,
    expiry: BigInt(epoch.expiry),
    windowLength: epoch.windowLength,
    collateralToken: side === 0 ? config.asset : config.usdg,
  });
}

export async function readSnapshot(client: PublicClient, config: KeeperConfig): Promise<Snapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const calendar = { address: config.calendar, abi: sessionCalendarAbi, blockNumber } as const;
  // The order count rides along every run. It's a plain getter on the same contract as the three
  // reads beside it, and it saves a call in every run that reads orders.
  const [lookback, bidWindow, latestExpiry, orderCount, latestBoundary, nextClose] =
    await Promise.all([
      client.readContract({ ...market, functionName: "LIVENESS_LOOKBACK" }),
      client.readContract({ ...market, functionName: "BID_WINDOW" }),
      client.readContract({ ...market, functionName: "latestExpiry", args: [config.asset] }),
      client.readContract({ ...market, functionName: "orderCount" }),
      client
        .readContract({
          ...calendar,
          functionName: "latestBoundaryAtOrBefore",
          args: [block.timestamp],
        })
        .then(
          (b): Boundary => ({
            close: Number(b.close),
            creationDeadline: Number(b.creationDeadline),
          }),
          noneOnRevert("NoCloseAtOrBefore"),
        ),
      client
        .readContract({ ...calendar, functionName: "nextCloseAfter", args: [block.timestamp] })
        .then((close) => Number(close), noneOnRevert("NoCloseAfter")),
    ]);

  const epoch =
    latestExpiry === 0n ? null : await readEpoch(client, config, blockNumber, latestExpiry);
  const epochAtLatest =
    epoch !== null && latestBoundary !== null && epoch.opening === latestBoundary.close;
  const due =
    latestBoundary !== null &&
    !epochAtLatest &&
    now > latestBoundary.close &&
    now < latestBoundary.creationDeadline;
  const readOrders =
    latestBoundary !== null &&
    now >= latestBoundary.close &&
    now < ordersReadUntil(latestBoundary.close, epochAtLatest ? epoch.batchDeadline : null);

  const [hint, orders] = await Promise.all([
    due ? roundHint(client, config.feed, latestBoundary.close, blockNumber) : null,
    readOrders ? readAllOrders(client, config, blockNumber, orderCount) : null,
  ]);
  const [series, buckets]: readonly [SeriesView[], BucketView[]] =
    orders === null
      ? [[], []]
      : await Promise.all([
          readSeries(client, config, blockNumber, orders),
          epoch === null ? [] : readBuckets(client, config, blockNumber, orders, epoch),
        ]);

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

async function readEpoch(
  client: PublicClient,
  config: KeeperConfig,
  blockNumber: bigint,
  expiry: bigint,
): Promise<EpochView> {
  const e = await client.readContract({
    address: config.market,
    abi: vayleMarketAbi,
    functionName: "epoch",
    args: [config.asset, expiry],
    blockNumber,
  });
  return {
    opening: Number(e.opening),
    expiry: Number(e.expiry),
    batchDeadline: Number(e.batchDeadline),
    windowLength: e.windowLength,
  };
}

async function readAllOrders(
  client: PublicClient,
  config: KeeperConfig,
  blockNumber: bigint,
  count: bigint,
): Promise<OrderView[]> {
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const orders = await client.multicall({
    contracts: ids.map(
      (id) =>
        ({
          address: config.market,
          abi: vayleMarketAbi,
          functionName: "orderOf",
          args: [id],
        }) as const,
    ),
    allowFailure: false,
    blockNumber,
    batchSize: ORDERS_PER_CALL * ORDER_OF_BYTES,
  });
  return orders
    .map((o, i) => ({ id: BigInt(i + 1), o }))
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
  return Promise.all(
    ids.map(async (id) => {
      const [key, windowEnd, pool] = await Promise.all([
        client.readContract({ ...market, functionName: "seriesKey", args: [id] }),
        client.readContract({ ...market, functionName: "windowEnd", args: [id] }),
        client.readContract({ ...market, functionName: "poolOf", args: [id] }),
      ]);
      return {
        id,
        expiry: Number(key.expiry),
        windowEnd: Number(windowEnd),
        settled: pool.settled,
      };
    }),
  );
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
  // A bucket's reads go out together, listed or not. The bid, batch and attached count of a strike
  // that isn't listed are dropped with it.
  const buckets = await Promise.all(
    [...seen.values()].map(async ({ side, target }) => {
      const series = bucketSeries(config, epoch, side, target);
      const [listed, bid, batch, attached] = await Promise.all([
        client.readContract({
          ...market,
          functionName: "isListedStrike",
          args: [config.asset, expiry, side, target],
        }),
        client.readContract({ ...market, functionName: "bestBid", args: [series] }),
        client.readContract({ ...market, functionName: "batchOf", args: [series] }),
        client.readContract({
          ...market,
          functionName: "attachedOrders",
          args: [config.asset, side, target],
        }),
      ]);
      if (!listed) return null;
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
    }),
  );
  return buckets.filter((b): b is BucketView => b !== null);
}
