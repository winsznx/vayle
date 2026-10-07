import { vayleMarketAbi } from "@vayle/abi";
import { seriesId } from "@vayle/market";
import {
  BaseError,
  ContractFunctionRevertedError,
  erc20Abi,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import type { MakerConfig } from "./config.ts";
import type { FeedRound, Reading } from "./guard.ts";
import type { Bucket, EpochTerms, Holding, IdleOrder, MakerSnapshot } from "./plan.ts";

// Every read is pinned to the block the run starts from, and reads that don't wait on each other
// start together. A client that batches through Multicall3 sends each such round as one aggregate3
// per 32 KiB of calls, so a snapshot costs the block, then a request for what needs only the block,
// one for the epoch and the orders, and one for what depends on those. A request that fails rejects
// every read in it, so the run stops there, as it always has when the RPC is down.

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const stockTokenAbi = parseAbi(["function oraclePaused() view returns (bool)"]);
const ACTIVE = 1;
const CALL = 0;
const PUT = 1;
const NO_MAKER = "0x0000000000000000000000000000000000000000";

function oneLine(error: unknown): string {
  const text =
    error instanceof BaseError
      ? `${error.name}: ${error.shortMessage}`
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return text.replace(/\s+/g, " ");
}

// Any failure of a price read is kept rather than thrown: the guard stands the maker down by name,
// and approving, exercising and withdrawing still go ahead. Batched, a reverting read fails alone,
// and a request that fails takes every read in it, these included.
async function reading<T>(read: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: oneLine(error) };
  }
}

function reverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((e) => e instanceof ContractFunctionRevertedError) !== null
  );
}

// A bucket of the current epoch to read: one per side and target among the idle orders.
export interface BucketKey {
  readonly side: number;
  readonly strike: bigint;
  readonly series: bigint;
}

// The series ID is the hash of the series' terms, worked out here rather than asked of the market.
export function bucketKeys(
  orders: readonly { readonly side: number; readonly target: bigint }[],
  epoch: Pick<EpochTerms, "expiry" | "windowLength">,
  config: Pick<MakerConfig, "chainId" | "asset" | "usdg">,
): BucketKey[] {
  const keys = new Map<string, BucketKey>();
  for (const { side, target } of orders) {
    const key = `${side}:${target.toString()}`;
    if (keys.has(key)) continue;
    keys.set(key, {
      side,
      strike: target,
      series: seriesId({
        chainId: BigInt(config.chainId),
        asset: config.asset,
        side,
        strike: target,
        expiry: BigInt(epoch.expiry),
        windowLength: epoch.windowLength,
        collateralToken: side === CALL ? config.asset : config.usdg,
      }),
    });
  }
  return [...keys.values()];
}

export async function readSnapshot(
  client: PublicClient,
  config: MakerConfig,
  maker: Address,
): Promise<MakerSnapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const usdg = { address: config.usdg, abi: erc20Abi, blockNumber } as const;
  const asset = { address: config.asset, abi: erc20Abi, blockNumber } as const;
  const feed = { address: config.feed, abi: feedAbi, blockNumber } as const;

  const [
    bidWindow,
    feeBps,
    latestExpiry,
    orderCount,
    callCaps,
    putCaps,
    usdgBalance,
    assetBalance,
    usdgAllowance,
    assetAllowance,
    claimableUsdg,
    claimableAsset,
    round,
    feedDecimals,
    oraclePaused,
  ] = await Promise.all([
    client.readContract({ ...market, functionName: "BID_WINDOW" }),
    client.readContract({ ...market, functionName: "feeBps" }),
    client.readContract({ ...market, functionName: "latestExpiry", args: [config.asset] }),
    client.readContract({ ...market, functionName: "orderCount" }),
    client.readContract({ ...market, functionName: "capsOf", args: [config.asset, CALL] }),
    client.readContract({ ...market, functionName: "capsOf", args: [config.asset, PUT] }),
    client.readContract({ ...usdg, functionName: "balanceOf", args: [maker] }),
    client.readContract({ ...asset, functionName: "balanceOf", args: [maker] }),
    client.readContract({ ...usdg, functionName: "allowance", args: [maker, config.market] }),
    client.readContract({ ...asset, functionName: "allowance", args: [maker, config.market] }),
    client.readContract({ ...market, functionName: "claimable", args: [maker, config.usdg] }),
    client.readContract({ ...market, functionName: "claimable", args: [maker, config.asset] }),
    reading(async (): Promise<FeedRound> => {
      const [roundId, answer, , updatedAt] = await client.readContract({
        ...feed,
        functionName: "latestRoundData",
      });
      return { roundId, answer, updatedAt: Number(updatedAt) };
    }),
    reading(() => client.readContract({ ...feed, functionName: "decimals" })),
    reading(() =>
      client.readContract({
        address: config.asset,
        abi: stockTokenAbi,
        functionName: "oraclePaused",
        blockNumber,
      }),
    ),
  ]);

  const ids = Array.from({ length: Number(orderCount) }, (_, i) => BigInt(i + 1));
  const [e, orders] = await Promise.all([
    latestExpiry === 0n
      ? null
      : client.readContract({
          ...market,
          functionName: "epoch",
          args: [config.asset, latestExpiry],
        }),
    Promise.all(
      ids.map(async (id) => ({
        id,
        o: await client.readContract({ ...market, functionName: "orderOf", args: [id] }),
      })),
    ),
  ]);
  const epoch: EpochTerms | null =
    e === null
      ? null
      : {
          opening: Number(e.opening),
          expiry: Number(e.expiry),
          batchDeadline: Number(e.batchDeadline),
          windowLength: e.windowLength,
          lot: e.lot,
          priceTick: e.priceTick,
          rawUnit: e.rawUnit,
        };

  const mine = orders.filter(({ o }) => o.asset === config.asset);
  const waiting = mine.filter(({ o }) => o.status === ACTIVE && o.series === 0n);
  const held = [...new Set(mine.filter(({ o }) => o.series !== 0n).map(({ o }) => o.series))];
  const reads = { client, market: config.market, maker, blockNumber };
  const [idle, buckets, holdings] = await Promise.all([
    Promise.all(
      waiting.map(async ({ id, o }): Promise<IdleOrder> => ({
        id,
        side: o.side,
        target: o.target,
        minPremium: o.minPremium,
        size: o.size,
        frozen: await client.readContract({ ...market, functionName: "frozen", args: [id] }),
      })),
    ),
    epoch === null
      ? []
      : readBuckets(
          reads,
          config.asset,
          epoch,
          bucketKeys(
            waiting.map(({ o }) => o),
            epoch,
            config,
          ),
          { call: callCaps, put: putCaps },
        ),
    readHoldings(reads, held),
  ]);

  return {
    now,
    maker,
    asset: config.asset,
    usdg: config.usdg,
    usdgDecimals: config.usdgDecimals,
    feeBps,
    bidWindow: Number(bidWindow),
    price: { round, feedDecimals, oraclePaused, reference: e === null ? null : e.referencePrice },
    epoch,
    buckets,
    idle,
    holdings,
    usdgBalance,
    assetBalance,
    usdgAllowance,
    assetAllowance,
    claimableUsdg,
    claimableAsset,
  };
}

interface Reads {
  readonly client: PublicClient;
  readonly market: Address;
  readonly maker: Address;
  readonly blockNumber: bigint;
}

interface Caps {
  readonly fillSize: bigint;
  readonly seriesOpenInterest: bigint;
}

// seriesKey reverts for a series nobody has registered yet. Only a revert means that: any other
// failure, a request that failed with its whole batch included, is thrown.
async function isRegistered(
  { client, market, blockNumber }: Reads,
  series: bigint,
): Promise<boolean> {
  try {
    await client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "seriesKey",
      args: [series],
      blockNumber,
    });
    return true;
  } catch (error) {
    if (reverted(error)) return false;
    throw error;
  }
}

// Every bucket's reads start together, whether or not its strike turns out to be listed.
async function readBuckets(
  reads: Reads,
  asset: Address,
  epoch: EpochTerms,
  keys: readonly BucketKey[],
  caps: { readonly call: Caps; readonly put: Caps },
): Promise<Bucket[]> {
  const { client, maker, blockNumber } = reads;
  const market = { address: reads.market, abi: vayleMarketAbi, blockNumber } as const;
  const expiry = BigInt(epoch.expiry);
  const buckets = await Promise.all(
    keys.map(async ({ side, strike, series }): Promise<Bucket | null> => {
      const [listed, registered, bid, pool] = await Promise.all([
        client.readContract({
          ...market,
          functionName: "isListedStrike",
          args: [asset, expiry, side, strike],
        }),
        isRegistered(reads, series),
        client.readContract({ ...market, functionName: "bestBid", args: [series] }),
        client.readContract({ ...market, functionName: "poolOf", args: [series] }),
      ]);
      if (!listed) return null;
      const cap = side === CALL ? caps.call : caps.put;
      return {
        side,
        strike,
        series,
        registered,
        bestBidder: bid.maker === NO_MAKER ? null : bid.maker,
        ownBid:
          bid.maker.toLowerCase() === maker.toLowerCase()
            ? { premium: bid.premium, amount: bid.amount }
            : null,
        fillSize: cap.fillSize,
        seriesRoom:
          cap.seriesOpenInterest > pool.written ? cap.seriesOpenInterest - pool.written : 0n,
      };
    }),
  );
  return buckets.filter((b): b is Bucket => b !== null);
}

// The series any of the asset's orders were written into, with the maker's balance and terms read
// together. A series the maker holds none of is dropped.
async function readHoldings(reads: Reads, held: readonly bigint[]): Promise<Holding[]> {
  const { client, maker, blockNumber } = reads;
  const market = { address: reads.market, abi: vayleMarketAbi, blockNumber } as const;
  const holdings = await Promise.all(
    held.map(async (series): Promise<Holding | null> => {
      const [balance, key, windowEnd] = await Promise.all([
        client.readContract({ ...market, functionName: "balanceOf", args: [maker, series] }),
        client.readContract({ ...market, functionName: "seriesKey", args: [series] }),
        client.readContract({ ...market, functionName: "windowEnd", args: [series] }),
      ]);
      if (balance === 0n) return null;
      return {
        series,
        side: key.optionType,
        strike: key.strike,
        expiry: Number(key.expiry),
        windowEnd: Number(windowEnd),
        balance,
      };
    }),
  );
  return holdings.filter((h): h is Holding => h !== null);
}
