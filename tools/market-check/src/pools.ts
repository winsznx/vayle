import { errorText } from "@vayle/chain-facts/rpc-errors";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import type { Handle, Rpc } from "./rpc.ts";
import {
  reads,
  sortPair,
  swapEvent,
  v4Pool,
  type Pool,
  type UniswapContracts,
  type V4Template,
} from "./uniswap.ts";

// Finding Uniswap pools that pair a token with USDG, or with a hub that pairs with USDG.
//
// v2 has one pair per two tokens, from the factory. v3 has one pool per two tokens and fee tier,
// from the factory, for every tier the factory has enabled. v4 pools are keyed by any fee, tick
// spacing and hooks contract, and nothing on chain lists them, short of scanning every Initialize
// event since launch. So the check samples recent swaps on the pool manager, recovers each traded
// pool's key from the position manager, and then tries every key shape it saw, plus the hookless
// tiers v3 uses, on each pair it needs. A v4 pool with a key shape nobody traded in the sample is
// missed.

// Twenty-four windows of 2,000 blocks, an hour apart at about ten blocks a second, so the sample
// spans the last day and holds a few minutes of every hour.
const SAMPLE_WINDOWS = 24;
const SAMPLE_BLOCKS = 2_000n;
const SAMPLE_STRIDE = 36_000n;
// The tiers UniswapV3Factory enables in its constructor. Others an owner enabled later are found
// by trying every fee the v4 sample saw.
const V3_CONSTRUCTOR_FEES = [500, 3000, 10000];
// Factory and state reads are a few storage lookups each, so 1,000 to a call is about 10M gas.
const READS_PER_CALL = 1_000;
const MAX_SPLITS = 3;
// How a node or viem refuses a log answer for its size.
const TOO_MANY_LOGS = /too large|size limit|size exceeded|more than/i;

export interface PoolIndex {
  // Every pool found with liquidity in range for the two currencies, any protocol.
  readonly between: (a: Address, b: Address) => readonly Pool[];
  // Every pool found with liquidity in range that has `currency` on one side.
  readonly involving: (currency: Address) => readonly Pool[];
  readonly v3Fees: readonly number[];
  readonly templates: number;
  readonly sampled: { readonly swaps: number; readonly pools: number; readonly unresolved: number };
  readonly notes: readonly string[];
}

function pairKey(a: Address, b: Address): string {
  const [c0, c1] = sortPair(a, b);
  return `${c0}:${c1}`;
}

// Swap logs in a block range, split in halves when the RPC refuses an answer that size.
async function swapIds(rpc: Rpc, pm: Address, from: bigint, to: bigint, depth = 0): Promise<Hex[]> {
  try {
    const logs = await rpc.client.getLogs({
      address: pm,
      event: swapEvent,
      fromBlock: from,
      toBlock: to,
    });
    return logs.flatMap((log) => (log.args.id === undefined ? [] : [log.args.id]));
  } catch (error) {
    if (depth >= MAX_SPLITS || to <= from || !TOO_MANY_LOGS.test(errorText(error))) {
      throw error;
    }
    const mid = (from + to) / 2n;
    return [
      ...(await swapIds(rpc, pm, from, mid, depth + 1)),
      ...(await swapIds(rpc, pm, mid + 1n, to, depth + 1)),
    ];
  }
}

export interface Discovery {
  readonly contracts: UniswapContracts;
  readonly usdg: Address;
  readonly weth: Address | null;
  // Tokens whose routes are wanted.
  readonly tokens: readonly Address[];
  // Every Stock Token, so key shapes seen on their pools count.
  readonly stockTokens: ReadonlySet<Address>;
}

export async function discoverPools(rpc: Rpc, d: Discovery): Promise<PoolIndex> {
  const c = d.contracts;
  const notes: string[] = [];

  // 1. Swaps on the pool manager in the sample windows, and the keys of the pools they traded in.
  const ids = new Set<Hex>();
  let swaps = 0;
  // One window at a time: each answer is megabytes, and a burst of them trips the RPC's rate limit.
  for (let w = 0; w < SAMPLE_WINDOWS; w++) {
    const to = rpc.blockNumber - BigInt(w) * SAMPLE_STRIDE;
    const found = await swapIds(rpc, c.v4PoolManager, to - SAMPLE_BLOCKS + 1n, to);
    swaps += found.length;
    for (const id of found) ids.add(id);
  }
  const keyBatch = rpc.batch({ perCall: READS_PER_CALL });
  const keyHandles = [...ids]
    .sort()
    .map((id) => keyBatch.add(reads.poolKey(c.v4PositionManager, id)));
  await keyBatch.run();
  const sampled: Pool[] = [];
  let unresolved = 0;
  for (const h of keyHandles) {
    const read = h.read();
    if (read.ok && read.value !== null) sampled.push(read.value);
    else unresolved++;
  }

  // 2. Key shapes worth trying: those on sampled pools that touch USDG or a Stock Token.
  const relevant = (currency: Address): boolean =>
    currency === d.usdg || d.stockTokens.has(currency);
  const shapes = new Map<string, V4Template>();
  const feesSeen = new Set<number>(V3_CONSTRUCTOR_FEES);
  for (const pool of sampled) {
    if (pool.fee !== null) feesSeen.add(pool.fee);
    if (!relevant(pool.currency0) && !relevant(pool.currency1)) continue;
    if (pool.fee === null || pool.tickSpacing === null || pool.hooks === null) continue;
    const shape = { fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks };
    shapes.set(`${shape.fee}:${shape.tickSpacing}:${shape.hooks}`, shape);
  }

  // 3. v3 tiers the factory has enabled, among the constructor's and every fee the sample saw.
  const tierBatch = rpc.batch({ perCall: READS_PER_CALL });
  const candidateFees = [...feesSeen].filter((f) => f > 0 && f < 1_000_000).sort((a, b) => a - b);
  const tierHandles = candidateFees.map((fee) => ({
    fee,
    handle: tierBatch.add(reads.feeAmountTickSpacing(c.v3Factory, fee)),
  }));
  await tierBatch.run();
  const v3Tiers: { fee: number; tickSpacing: number }[] = [];
  for (const { fee, handle } of tierHandles) {
    const read = handle.read();
    if (read.ok && read.value > 0) v3Tiers.push({ fee, tickSpacing: read.value });
    if (!read.ok) notes.push(`feeAmountTickSpacing(${fee}): ${read.error}`);
  }
  for (const t of v3Tiers) {
    const shape = { fee: t.fee, tickSpacing: t.tickSpacing, hooks: zeroAddress };
    shapes.set(`${shape.fee}:${shape.tickSpacing}:${shape.hooks}`, shape);
  }

  // 4. The pairs to look up: each token with USDG, WETH and ETH, and the hubs with USDG.
  const pairs = new Map<string, readonly [Address, Address]>();
  const addPair = (a: Address, b: Address): void => {
    pairs.set(pairKey(a, b), sortPair(a, b));
  };
  for (const t of d.tokens) {
    addPair(t, d.usdg);
    addPair(t, zeroAddress);
    if (d.weth !== null) addPair(t, d.weth);
  }
  addPair(zeroAddress, d.usdg);
  if (d.weth !== null) addPair(d.weth, d.usdg);

  const lookup = rpc.batch({ perCall: READS_PER_CALL });
  const v2Handles: { pair: readonly [Address, Address]; handle: Handle<Address> }[] = [];
  const v3Handles: {
    pair: readonly [Address, Address];
    fee: number;
    tickSpacing: number;
    handle: Handle<Address>;
  }[] = [];
  const v4Handles: { pool: Pool; handle: Handle<bigint> }[] = [];
  for (const pair of pairs.values()) {
    const [a, b] = pair;
    // v2 and v3 pair ERC-20s only, so native ETH has no pools there.
    if (a !== zeroAddress) {
      v2Handles.push({ pair, handle: lookup.add(reads.getPair(c.v2Factory, a, b)) });
      for (const t of v3Tiers) {
        v3Handles.push({ pair, ...t, handle: lookup.add(reads.getPool(c.v3Factory, a, b, t.fee)) });
      }
    }
    for (const shape of shapes.values()) {
      const pool = v4Pool(a, b, shape);
      v4Handles.push({ pool, handle: lookup.add(reads.sqrtPrice(c.v4StateView, pool.id)) });
    }
  }
  // Sampled pools on the tokens' other pairs, so a hub other than USDG, WETH and ETH can route.
  const tokenSet = new Set(d.tokens);
  const sampledPairs = sampled.filter(
    (p) =>
      tokenSet.has(p.currency0) ||
      tokenSet.has(p.currency1) ||
      p.currency0 === d.usdg ||
      p.currency1 === d.usdg,
  );
  for (const pool of sampledPairs) {
    v4Handles.push({ pool, handle: lookup.add(reads.sqrtPrice(c.v4StateView, pool.id)) });
  }
  await lookup.run();

  // 5. Liquidity in range for every pool that exists, so empty pools aren't quoted.
  const found: Pool[] = [];
  const liquidityBatch = rpc.batch({ perCall: READS_PER_CALL });
  const liquidityHandles: { pool: Pool; handle: Handle<bigint> }[] = [];
  for (const { pair, handle } of v2Handles) {
    const read = handle.read();
    if (read.ok && read.value !== zeroAddress) {
      found.push({
        protocol: "uniswap-v2",
        id: getAddress(read.value),
        currency0: pair[0],
        currency1: pair[1],
        fee: null,
        tickSpacing: null,
        hooks: null,
      });
    }
  }
  for (const { pair, fee, tickSpacing, handle } of v3Handles) {
    const read = handle.read();
    if (read.ok && read.value !== zeroAddress) {
      const pool: Pool = {
        protocol: "uniswap-v3",
        id: getAddress(read.value),
        currency0: pair[0],
        currency1: pair[1],
        fee,
        tickSpacing,
        hooks: null,
      };
      liquidityHandles.push({
        pool,
        handle: liquidityBatch.add(reads.v3Liquidity(getAddress(read.value))),
      });
    }
  }
  const seen = new Set<Hex>();
  for (const { pool, handle } of v4Handles) {
    const read = handle.read();
    if (!read.ok || read.value === 0n || seen.has(pool.id)) continue;
    seen.add(pool.id);
    liquidityHandles.push({
      pool,
      handle: liquidityBatch.add(reads.v4Liquidity(c.v4StateView, pool.id)),
    });
  }
  await liquidityBatch.run();
  for (const { pool, handle } of liquidityHandles) {
    const read = handle.read();
    if (read.ok && read.value > 0n) found.push(pool);
  }

  const index = new Map<string, Pool[]>();
  for (const pool of found) {
    const key = pairKey(pool.currency0, pool.currency1);
    index.set(key, [...(index.get(key) ?? []), pool]);
  }
  return {
    between: (a, b) => index.get(pairKey(a, b)) ?? [],
    involving: (currency) =>
      found.filter((p) => p.currency0 === currency || p.currency1 === currency),
    v3Fees: v3Tiers.map((t) => t.fee),
    templates: shapes.size,
    sampled: { swaps, pools: ids.size, unresolved },
    notes,
  };
}
