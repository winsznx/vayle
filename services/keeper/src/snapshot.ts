import { sessionCalendarAbi, stockTokenRegistryAbi, vayleMarketAbi } from "@vayle/abi";
import { errorText } from "@vayle/chain-facts/rpc-errors";
import { seriesId } from "@vayle/market";
import { listingDifferences, type Listing, type Market } from "@vayle/markets";
import {
  AbiDecodingDataSizeTooSmallError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Address,
  type PublicClient,
} from "viem";
import type { KeeperConfig } from "./config.ts";
import { firstEpochHint, latestRound, roundHint } from "./hint.ts";
import type {
  BatchPhase,
  Boundary,
  BucketView,
  EpochView,
  MarketView,
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
// so the client sends each group as one Multicall3 call, every market's reads in the same calls. The
// order book is the one group that grows without bound. orderOf measured about 29,000 gas on the
// fork, so a full 32 KiB call of them would take more than half of the node's 50M gas cap for an
// eth_call. Orders go in calls of their own instead, at most this many each (11.7M gas measured),
// all sent at once.
export const ORDERS_PER_CALL = 400;
// orderOf's calldata: a 4-byte selector and one 32-byte ID.
const ORDER_OF_BYTES = 36;

// OrderStatus in the contract: None, Active, Cancelled, Closed. None never comes back for a real ID.
const STATUS: readonly OrderStatus[] = ["closed", "active", "cancelled", "closed"];
const PHASES: readonly BatchPhase[] = ["none", "counting", "filling", "done"];

// Something about one market that the run logs: why it was left out, or what it couldn't read.
export interface MarketNote {
  readonly symbol: string;
  readonly text: string;
}

export interface SnapshotRead {
  readonly snapshot: Snapshot;
  readonly notes: readonly MarketNote[];
}

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
    if (isRevert(error, "NotListed")) return "it isn't listed in the token registry";
    if (refused(error)) return `its listing couldn't be read: ${errorText(error)}`;
    throw error;
  }
}

// A market's feed read that its own feed may refuse: the value, or a note on why there's none.
async function feedRead<T>(
  symbol: string,
  what: string,
  read: Promise<T>,
): Promise<{ value: T | null; note: MarketNote | null }> {
  try {
    return { value: await read, note: null };
  } catch (error) {
    if (!refused(error)) throw error;
    return { value: null, note: { symbol, text: `${what}: ${errorText(error)}` } };
  }
}

// The ID the market gives the series at a bucket's target in `epoch`, registered or not. These are
// the terms the market hashes: calls are collateralized in the asset and puts in USDG.
export function bucketSeries(
  chain: Pick<KeeperConfig, "chainId" | "usdg">,
  asset: Address,
  epoch: EpochView,
  side: number,
  target: bigint,
): bigint {
  return seriesId({
    chainId: BigInt(chain.chainId),
    asset,
    side,
    strike: target,
    expiry: BigInt(epoch.expiry),
    windowLength: epoch.windowLength,
    collateralToken: side === 0 ? asset : chain.usdg,
  });
}

export async function readSnapshot(
  client: PublicClient,
  config: KeeperConfig,
): Promise<SnapshotRead> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const calendar = { address: config.calendar, abi: sessionCalendarAbi, blockNumber } as const;
  const registry = { address: config.registry, abi: stockTokenRegistryAbi, blockNumber } as const;
  // One call: the market's getters, the calendar's place in the week, and each market's latest
  // expiry and listing. The order count rides along every run. It's a plain getter on the same
  // contract as the reads beside it, and it saves a call in every run that reads orders.
  const [[lookback, bidWindow, deployedAt, orderCount, latestBoundary, nextClose], listed] =
    await Promise.all([
      Promise.all([
        client.readContract({ ...market, functionName: "LIVENESS_LOOKBACK" }),
        client.readContract({ ...market, functionName: "BID_WINDOW" }),
        client.readContract({ ...market, functionName: "deployedAt" }),
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
      ]),
      Promise.all(
        config.markets.map(async (m) => {
          const [latestExpiry, problem] = await Promise.all([
            client.readContract({ ...market, functionName: "latestExpiry", args: [m.token] }),
            listingProblem(
              m,
              client.readContract({ ...registry, functionName: "asset", args: [m.token] }),
            ),
          ]);
          return { market: m, latestExpiry, problem };
        }),
      ),
    ]);

  const notes: MarketNote[] = [];
  const checked: { market: Market; latestExpiry: bigint }[] = [];
  for (const { market: m, latestExpiry, problem } of listed) {
    if (problem === null) checked.push({ market: m, latestExpiry });
    else notes.push({ symbol: m.symbol, text: `skipped this run: ${problem}` });
  }

  // Before the schedule's first close, a market with no epoch yet waits for its first week, which
  // can open once the liveness record covers a lookback after the market's deployment.
  const firstOpens =
    latestBoundary === null && nextClose !== null && now >= Number(deployedAt) + Number(lookback);
  const epochs = await Promise.all(
    checked.map(async ({ market: m, latestExpiry }) => {
      const [epoch, first] = await Promise.all([
        latestExpiry === 0n ? null : readEpoch(client, config, m.token, latestExpiry, blockNumber),
        latestExpiry === 0n && firstOpens
          ? feedRead(
              m.symbol,
              "has no first week this run, its feed's latest round couldn't be read",
              latestRound(client, m.feed, blockNumber),
            )
          : null,
      ]);
      if (first?.note) notes.push(first.note);
      const epochAtLatest =
        epoch !== null && latestBoundary !== null && epoch.opening === latestBoundary.close;
      return {
        market: m,
        epoch,
        epochAtLatest,
        firstHint: first?.value ? firstEpochHint(first.value, now) : null,
      };
    }),
  );
  const atLatest = epochs.flatMap((e) => (e.epochAtLatest && e.epoch ? [e.epoch] : []));
  const readOrders =
    latestBoundary !== null &&
    now >= latestBoundary.close &&
    now <
      ordersReadUntil(
        latestBoundary.close,
        atLatest.length === 0 ? null : Math.max(...atLatest.map((e) => e.batchDeadline)),
      );

  const [hints, orders] = await Promise.all([
    Promise.all(
      epochs.map(async ({ market: m, epochAtLatest }) => {
        const due =
          latestBoundary !== null &&
          !epochAtLatest &&
          now > latestBoundary.close &&
          now < latestBoundary.creationDeadline;
        if (!due) return null;
        const hint = await feedRead(
          m.symbol,
          "has no round hint this run, its feed couldn't be read",
          roundHint(client, m.feed, latestBoundary.close, blockNumber),
        );
        if (hint.note) notes.push(hint.note);
        return hint.value;
      }),
    ),
    readOrders
      ? readAllOrders(
          client,
          config,
          blockNumber,
          orderCount,
          new Set(checked.map(({ market: m }) => m.token)),
        )
      : null,
  ]);
  const [series, buckets]: readonly [SeriesView[], BucketView[][]] =
    orders === null
      ? [[], epochs.map(() => [])]
      : await Promise.all([
          readSeries(client, config, blockNumber, orders),
          Promise.all(
            epochs.map(async ({ market: m, epoch }) =>
              epoch === null
                ? []
                : readBuckets(client, config, blockNumber, orders, m.token, epoch),
            ),
          ),
        ]);

  const markets = epochs.map(({ market: m, epoch, epochAtLatest, firstHint }, i): MarketView => ({
    asset: m.token,
    epoch,
    epochAtLatest,
    roundHint: hints[i] ?? null,
    firstHint,
    buckets: buckets[i] ?? [],
  }));
  return {
    snapshot: {
      now,
      lookback: Number(lookback),
      bidWindow: Number(bidWindow),
      deployedAt: Number(deployedAt),
      latestBoundary,
      nextClose,
      markets,
      series,
      orders,
    },
    notes,
  };
}

async function readEpoch(
  client: PublicClient,
  config: KeeperConfig,
  asset: Address,
  expiry: bigint,
  blockNumber: bigint,
): Promise<EpochView> {
  const e = await client.readContract({
    address: config.market,
    abi: vayleMarketAbi,
    functionName: "epoch",
    args: [asset, expiry],
    blockNumber,
  });
  return {
    opening: Number(e.opening),
    expiry: Number(e.expiry),
    batchDeadline: Number(e.batchDeadline),
    windowLength: e.windowLength,
  };
}

// Every order of the markets acted on this run. Orders of any other token are dropped.
async function readAllOrders(
  client: PublicClient,
  config: KeeperConfig,
  blockNumber: bigint,
  count: bigint,
  assets: ReadonlySet<Address>,
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
    .filter(({ o }) => assets.has(o.asset))
    .map(({ id, o }) => ({
      id,
      asset: o.asset,
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
  asset: Address,
  epoch: EpochView,
): Promise<BucketView[]> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const seen = new Map<string, { side: number; target: bigint }>();
  for (const o of orders) {
    if (o.asset === asset && o.status === "active" && o.series === 0n) {
      seen.set(`${o.side}:${o.target.toString()}`, { side: o.side, target: o.target });
    }
  }
  const expiry = BigInt(epoch.expiry);
  // A bucket's reads go out together, listed or not. The bid, batch and attached count of a strike
  // that isn't listed are dropped with it.
  const buckets = await Promise.all(
    [...seen.values()].map(async ({ side, target }) => {
      const series = bucketSeries(config, asset, epoch, side, target);
      const [listed, bid, batch, attached] = await Promise.all([
        client.readContract({
          ...market,
          functionName: "isListedStrike",
          args: [asset, expiry, side, target],
        }),
        client.readContract({ ...market, functionName: "bestBid", args: [series] }),
        client.readContract({ ...market, functionName: "batchOf", args: [series] }),
        client.readContract({
          ...market,
          functionName: "attachedOrders",
          args: [asset, side, target],
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
