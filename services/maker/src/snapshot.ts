import { vayleMarketAbi } from "@vayle/abi";
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

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const stockTokenAbi = parseAbi(["function oraclePaused() view returns (bool)"]);
const ACTIVE = 1;
const READ_BATCH = 20;

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
// and approving, exercising and withdrawing still go ahead.
async function reading<T>(read: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: oneLine(error) };
  }
}

async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(read))));
  }
  return results;
}

function reverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((e) => e instanceof ContractFunctionRevertedError) !== null
  );
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
  const [bidWindow, feeBps, latestExpiry, round, feedDecimals, oraclePaused] = await Promise.all([
    client.readContract({ ...market, functionName: "BID_WINDOW" }),
    client.readContract({ ...market, functionName: "feeBps" }),
    client.readContract({ ...market, functionName: "latestExpiry", args: [config.asset] }),
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
  const [usdgBalance, assetBalance, usdgAllowance, assetAllowance, claimableUsdg, claimableAsset] =
    await Promise.all([
      client.readContract({ ...usdg, functionName: "balanceOf", args: [maker] }),
      client.readContract({ ...asset, functionName: "balanceOf", args: [maker] }),
      client.readContract({ ...usdg, functionName: "allowance", args: [maker, config.market] }),
      client.readContract({ ...asset, functionName: "allowance", args: [maker, config.market] }),
      client.readContract({ ...market, functionName: "claimable", args: [maker, config.usdg] }),
      client.readContract({ ...market, functionName: "claimable", args: [maker, config.asset] }),
    ]);

  let epoch: EpochTerms | null = null;
  let reference: bigint | null = null;
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
      lot: e.lot,
      priceTick: e.priceTick,
      rawUnit: e.rawUnit,
    };
    reference = e.referencePrice;
  }

  const count = await client.readContract({ ...market, functionName: "orderCount" });
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const orders = (
    await inBatches(ids, async (id) => ({
      id,
      o: await client.readContract({ ...market, functionName: "orderOf", args: [id] }),
    }))
  ).filter(({ o }) => o.asset === config.asset);

  const idle: IdleOrder[] = await inBatches(
    orders.filter(({ o }) => o.status === ACTIVE && o.series === 0n),
    async ({ id, o }) => ({
      id,
      side: o.side,
      target: o.target,
      minPremium: o.minPremium,
      size: o.size,
      frozen: await client.readContract({ ...market, functionName: "frozen", args: [id] }),
    }),
  );

  const buckets =
    epoch === null ? [] : await readBuckets(client, config, maker, blockNumber, idle, epoch);
  const held = [...new Set(orders.filter(({ o }) => o.series !== 0n).map(({ o }) => o.series))];
  const holdings = (
    await inBatches(held, async (series): Promise<Holding | null> => {
      const balance = await client.readContract({
        ...market,
        functionName: "balanceOf",
        args: [maker, series],
      });
      if (balance === 0n) return null;
      const [key, windowEnd] = await Promise.all([
        client.readContract({ ...market, functionName: "seriesKey", args: [series] }),
        client.readContract({ ...market, functionName: "windowEnd", args: [series] }),
      ]);
      return {
        series,
        side: key.optionType,
        strike: key.strike,
        expiry: Number(key.expiry),
        windowEnd: Number(windowEnd),
        balance,
      };
    })
  ).filter((h): h is Holding => h !== null);

  return {
    now,
    maker,
    asset: config.asset,
    usdg: config.usdg,
    usdgDecimals: config.usdgDecimals,
    feeBps,
    bidWindow: Number(bidWindow),
    price: { round, feedDecimals, oraclePaused, reference },
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

async function readBuckets(
  client: PublicClient,
  config: MakerConfig,
  maker: Address,
  blockNumber: bigint,
  idle: readonly IdleOrder[],
  epoch: EpochTerms,
): Promise<Bucket[]> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const keys = new Map<string, { side: number; strike: bigint }>();
  for (const o of idle)
    keys.set(`${o.side}:${o.target.toString()}`, { side: o.side, strike: o.target });
  const expiry = BigInt(epoch.expiry);
  const buckets = await inBatches(
    [...keys.values()],
    async ({ side, strike }): Promise<Bucket | null> => {
      const listed = await client.readContract({
        ...market,
        functionName: "isListedStrike",
        args: [config.asset, expiry, side, strike],
      });
      if (!listed) return null;
      const { result: series } = await client.simulateContract({
        address: config.market,
        abi: vayleMarketAbi,
        functionName: "seriesFor",
        args: [config.asset, expiry, side, strike],
        blockNumber,
      });
      let registered = true;
      try {
        await client.readContract({ ...market, functionName: "seriesKey", args: [series] });
      } catch (error) {
        if (!reverted(error)) throw error;
        registered = false;
      }
      const [bid, caps, pool] = await Promise.all([
        client.readContract({ ...market, functionName: "bestBid", args: [series] }),
        client.readContract({ ...market, functionName: "capsOf", args: [config.asset, side] }),
        client.readContract({ ...market, functionName: "poolOf", args: [series] }),
      ]);
      const zero = "0x0000000000000000000000000000000000000000";
      return {
        side,
        strike,
        series,
        registered,
        bestBidder: bid.maker === zero ? null : bid.maker,
        ownBid:
          bid.maker.toLowerCase() === maker.toLowerCase()
            ? { premium: bid.premium, amount: bid.amount }
            : null,
        fillSize: caps.fillSize,
        seriesRoom:
          caps.seriesOpenInterest > pool.written ? caps.seriesOpenInterest - pool.written : 0n,
      };
    },
  );
  return buckets.filter((b): b is Bucket => b !== null);
}
