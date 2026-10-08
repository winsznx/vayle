import { stockTokenRegistryAbi, vayleMarketAbi } from "@vayle/abi";
import { errorText } from "@vayle/chain-facts/rpc-errors";
import { seriesId } from "@vayle/market";
import { listingDifferences, type Listing, type Market } from "@vayle/markets";
import {
  AbiDecodingDataSizeTooSmallError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  erc20Abi,
  parseAbi,
  type Address,
  type ContractFunctionReturnType,
  type PublicClient,
} from "viem";
import { closeAnswers } from "./close.ts";
import type { MakerConfig } from "./config.ts";
import type { FeedRound, Reading } from "./guard.ts";
import type { Bucket, EpochTerms, Holding, IdleOrder, MakerSnapshot, MarketState } from "./plan.ts";

// Every read is pinned to the block the run starts from, and reads that don't wait on each other
// start together, every market's in the same calls. A client that batches through Multicall3 sends
// each such round as one aggregate3 per 16 KiB of calls, so a snapshot costs the block, then a
// request for what needs only the block, one for the epochs and the orders, and one for what depends
// on those. While a series the maker holds is in its exercise window, one more reads the close it
// expired at. A request that fails rejects every read in it, so the run stops there, as it always
// has when the RPC is down.

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const stockTokenAbi = parseAbi(["function oraclePaused() view returns (bool)"]);
const ACTIVE = 1;
const CALL = 0;
const PUT = 1;
const BPS = 10_000n;
const NO_MAKER = "0x0000000000000000000000000000000000000000";

type Caps = ContractFunctionReturnType<typeof vayleMarketAbi, "view", "capsOf">;

// Something about one market that the run logs: why it was left out, or what it couldn't read.
export interface MarketNote {
  readonly symbol: string;
  readonly text: string;
}

export interface SnapshotRead {
  readonly snapshot: MakerSnapshot;
  readonly notes: readonly MarketNote[];
}

export interface SnapshotOptions {
  // Every target the week lists, as the bid sheet needs, instead of only those with idle orders.
  readonly everyTarget?: boolean;
}

// Any failure of a price read is kept rather than thrown: the guard stands the market down by name,
// and approving, exercising and withdrawing still go ahead. Batched, a reverting read fails alone,
// and a request that fails takes every read in it, these included.
async function reading<T>(read: () => Promise<T>): Promise<Reading<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function reverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((e) => e instanceof ContractFunctionRevertedError) !== null
  );
}

// Whether a read failed at its contract, by reverting or with an answer its ABI can't decode, as
// opposed to its request failing. A failed request takes every read in it, every market's
// included, so only a refusal is pinned on one market and the others go ahead.
export function refused(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof AbiDecodingDataSizeTooSmallError,
    ) !== null
  );
}

// Why a market can't be acted on this run, or null when its listing in the token registry is the
// one the markets file states.
export async function listingProblem(
  market: Market,
  listing: Promise<Listing>,
): Promise<string | null> {
  try {
    const differences = listingDifferences(market, await listing);
    return differences.length === 0 ? null : differences.join("; ");
  } catch (error) {
    if (
      error instanceof BaseError &&
      error.walk(
        (e) => e instanceof ContractFunctionRevertedError && e.data?.errorName === "NotListed",
      ) !== null
    ) {
      return "it isn't listed in the token registry";
    }
    if (refused(error)) return `its listing couldn't be read: ${errorText(error)}`;
    throw error;
  }
}

// Why the maker's token reads failed for a market, or null when they didn't. A token that refuses
// them leaves out only its own market.
async function tokenProblem(reads: readonly Promise<unknown>[]): Promise<string | null> {
  try {
    await Promise.all(reads);
    return null;
  } catch (error) {
    if (refused(error)) return `its token couldn't be read: ${errorText(error)}`;
    throw error;
  }
}

// A bucket of a market's current epoch to read: one per side and target.
export interface BucketKey {
  readonly side: number;
  readonly strike: bigint;
  readonly series: bigint;
}

// The targets a week lists on a side, the market's own rule: out of the money, on the strike tick,
// within the band around the week's reference price. Lowest first.
export function listedTargets(
  e: Pick<EpochTerms, "referencePrice" | "strikeTick" | "strikeRangeBps">,
  side: number,
): bigint[] {
  const { referencePrice: reference, strikeTick: tick } = e;
  const band = (reference * BigInt(e.strikeRangeBps)) / BPS;
  const targets: bigint[] = [];
  if (side === CALL) {
    for (let strike = (reference / tick + 1n) * tick; strike <= reference + band; strike += tick) {
      targets.push(strike);
    }
  } else {
    const below = reference === 0n ? 0n : ((reference - 1n) / tick) * tick;
    for (let strike = below; strike > 0n && strike + band >= reference; strike -= tick) {
      targets.unshift(strike);
    }
  }
  return targets;
}

// The series ID is the hash of the series' terms, worked out here rather than asked of the market.
export function bucketKeys(
  targets: readonly { readonly side: number; readonly target: bigint }[],
  epoch: Pick<EpochTerms, "expiry" | "windowLength">,
  token: Address,
  chain: Pick<MakerConfig, "chainId" | "usdg">,
): BucketKey[] {
  const keys = new Map<string, BucketKey>();
  for (const { side, target } of targets) {
    const key = `${side}:${target.toString()}`;
    if (keys.has(key)) continue;
    keys.set(key, {
      side,
      strike: target,
      series: seriesId({
        chainId: BigInt(chain.chainId),
        asset: token,
        side,
        strike: target,
        expiry: BigInt(epoch.expiry),
        windowLength: epoch.windowLength,
        collateralToken: side === CALL ? token : chain.usdg,
      }),
    });
  }
  return [...keys.values()];
}

interface MarketReads {
  readonly market: Market;
  readonly latestExpiry: bigint;
  readonly caps: { readonly call: Caps; readonly put: Caps };
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly claimable: bigint;
  readonly round: Reading<FeedRound>;
  readonly feedDecimals: Reading<number>;
  readonly oraclePaused: Reading<boolean>;
  readonly problem: string | null;
}

// A market's reads that need only the block, started together with every other market's.
async function readMarket(
  client: PublicClient,
  config: MakerConfig,
  m: Market,
  maker: Address,
  blockNumber: bigint,
): Promise<MarketReads> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const token = { address: m.token, abi: erc20Abi, blockNumber } as const;
  const feed = { address: m.feed, abi: feedAbi, blockNumber } as const;
  const balance = client.readContract({ ...token, functionName: "balanceOf", args: [maker] });
  const allowance = client.readContract({
    ...token,
    functionName: "allowance",
    args: [maker, config.market],
  });
  const [
    latestExpiry,
    callCaps,
    putCaps,
    claimable,
    round,
    feedDecimals,
    oraclePaused,
    listing,
    tokens,
  ] = await Promise.all([
    client.readContract({ ...market, functionName: "latestExpiry", args: [m.token] }),
    client.readContract({ ...market, functionName: "capsOf", args: [m.token, CALL] }),
    client.readContract({ ...market, functionName: "capsOf", args: [m.token, PUT] }),
    client.readContract({ ...market, functionName: "claimable", args: [maker, m.token] }),
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
        address: m.token,
        abi: stockTokenAbi,
        functionName: "oraclePaused",
        blockNumber,
      }),
    ),
    listingProblem(
      m,
      client.readContract({
        address: config.registry,
        abi: stockTokenRegistryAbi,
        functionName: "asset",
        args: [m.token],
        blockNumber,
      }),
    ),
    tokenProblem([balance, allowance]),
  ]);
  return {
    market: m,
    latestExpiry,
    caps: { call: callCaps, put: putCaps },
    // A token problem means these are never used, so a refused read stands as zero.
    balance: tokens === null ? await balance : 0n,
    allowance: tokens === null ? await allowance : 0n,
    claimable,
    round,
    feedDecimals,
    oraclePaused,
    problem: listing ?? tokens,
  };
}

export async function readSnapshot(
  client: PublicClient,
  config: MakerConfig,
  maker: Address,
  { everyTarget = false }: SnapshotOptions = {},
): Promise<SnapshotRead> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const usdg = { address: config.usdg, abi: erc20Abi, blockNumber } as const;

  const [bidWindow, feeBps, orderCount, usdgBalance, usdgAllowance, claimableUsdg, perMarket] =
    await Promise.all([
      client.readContract({ ...market, functionName: "BID_WINDOW" }),
      client.readContract({ ...market, functionName: "feeBps" }),
      client.readContract({ ...market, functionName: "orderCount" }),
      client.readContract({ ...usdg, functionName: "balanceOf", args: [maker] }),
      client.readContract({ ...usdg, functionName: "allowance", args: [maker, config.market] }),
      client.readContract({ ...market, functionName: "claimable", args: [maker, config.usdg] }),
      Promise.all(config.markets.map((m) => readMarket(client, config, m, maker, blockNumber))),
    ]);

  const notes: MarketNote[] = [];
  const checked: MarketReads[] = [];
  for (const reads of perMarket) {
    if (reads.problem === null) checked.push(reads);
    else notes.push({ symbol: reads.market.symbol, text: `skipped this run: ${reads.problem}` });
  }
  const tokens = new Set(checked.map((r) => r.market.token));

  const ids = Array.from({ length: Number(orderCount) }, (_, i) => BigInt(i + 1));
  const [epochs, orders] = await Promise.all([
    Promise.all(
      checked.map(async (r) =>
        r.latestExpiry === 0n
          ? null
          : client.readContract({
              ...market,
              functionName: "epoch",
              args: [r.market.token, r.latestExpiry],
            }),
      ),
    ),
    Promise.all(
      ids.map(async (id) => ({
        id,
        o: await client.readContract({ ...market, functionName: "orderOf", args: [id] }),
      })),
    ),
  ]);

  const mine = orders.filter(({ o }) => tokens.has(o.asset));
  const waiting = mine.filter(({ o }) => o.status === ACTIVE && o.series === 0n);
  const held = [...new Set(mine.filter(({ o }) => o.series !== 0n).map(({ o }) => o.series))];
  const reads = { client, market: config.market, maker, blockNumber };
  const [idle, buckets, holdings] = await Promise.all([
    Promise.all(
      waiting.map(async ({ id, o }): Promise<IdleOrder> => ({
        id,
        asset: o.asset,
        side: o.side,
        target: o.target,
        minPremium: o.minPremium,
        size: o.size,
        frozen: await client.readContract({ ...market, functionName: "frozen", args: [id] }),
      })),
    ),
    Promise.all(
      checked.map(async (r, i): Promise<Bucket[]> => {
        const e = epochs[i] ?? null;
        if (e === null) return [];
        const epoch = epochTerms(e);
        const targets = [CALL, PUT]
          .filter((side) => (side === CALL ? r.market.sell : r.market.buy).enabled)
          .flatMap((side) => listedTargets(epoch, side).map((target) => ({ side, target })))
          .filter(
            ({ side, target }) =>
              everyTarget ||
              waiting.some(
                ({ o }) => o.asset === r.market.token && o.side === side && o.target === target,
              ),
          );
        return readBuckets(reads, bucketKeys(targets, epoch, r.market.token, config), r.caps);
      }),
    ),
    readHoldings(reads, held),
  ]);

  // The close each held series in its exercise window expired at, read only then.
  const closes = await Promise.all(
    checked.map(async (r) => {
      const open = [
        ...new Set(
          holdings
            .filter((h) => h.asset === r.market.token && now >= h.expiry && now < h.windowEnd)
            .map((h) => h.expiry),
        ),
      ];
      if (open.length === 0 || !r.round.ok) return new Map<number, bigint | null>();
      return closeAnswers(client, r.market.feed, r.round.value.roundId, open, blockNumber);
    }),
  );

  const markets = checked.map((r, i): MarketState => {
    const e = epochs[i] ?? null;
    return {
      market: r.market,
      price: {
        round: r.round,
        feedDecimals: r.feedDecimals,
        oraclePaused: r.oraclePaused,
        reference: e === null ? null : e.referencePrice,
      },
      epoch: e === null ? null : epochTerms(e),
      buckets: buckets[i] ?? [],
      balance: r.balance,
      allowance: r.allowance,
      claimable: r.claimable,
      closes: closes[i] ?? new Map<number, bigint | null>(),
    };
  });
  return {
    snapshot: {
      block: blockNumber,
      now,
      maker,
      usdg: config.usdg,
      usdgDecimals: config.usdgDecimals,
      feeBps,
      bidWindow: Number(bidWindow),
      markets,
      idle,
      holdings,
      usdgBalance,
      usdgAllowance,
      claimableUsdg,
    },
    notes,
  };
}

function epochTerms(
  e: ContractFunctionReturnType<typeof vayleMarketAbi, "view", "epoch">,
): EpochTerms {
  return {
    opening: Number(e.opening),
    expiry: Number(e.expiry),
    batchDeadline: Number(e.batchDeadline),
    windowLength: e.windowLength,
    lot: e.lot,
    priceTick: e.priceTick,
    rawUnit: e.rawUnit,
    referencePrice: e.referencePrice,
    strikeTick: e.strikeTick,
    strikeRangeBps: e.strikeRangeBps,
  };
}

interface Reads {
  readonly client: PublicClient;
  readonly market: Address;
  readonly maker: Address;
  readonly blockNumber: bigint;
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

// Every bucket's reads start together.
async function readBuckets(
  reads: Reads,
  keys: readonly BucketKey[],
  caps: { readonly call: Caps; readonly put: Caps },
): Promise<Bucket[]> {
  const { client, maker, blockNumber } = reads;
  const market = { address: reads.market, abi: vayleMarketAbi, blockNumber } as const;
  return Promise.all(
    keys.map(async ({ side, strike, series }): Promise<Bucket> => {
      const [registered, bid, pool] = await Promise.all([
        isRegistered(reads, series),
        client.readContract({ ...market, functionName: "bestBid", args: [series] }),
        client.readContract({ ...market, functionName: "poolOf", args: [series] }),
      ]);
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
        written: pool.written,
        seriesRoom:
          cap.seriesOpenInterest > pool.written ? cap.seriesOpenInterest - pool.written : 0n,
      };
    }),
  );
}

// The series any of the markets' orders were written into, with the maker's balance and terms read
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
        asset: key.asset,
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
