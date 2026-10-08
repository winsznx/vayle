import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  sliceHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { SourceMismatch } from "./errors.ts";
import type { Call, Probe } from "./rpc.ts";
import type { PoolLeg, Venue } from "./types.ts";

// Uniswap on Robinhood Chain: where its contracts are, how its pools are named, and how its own
// quoters price a sale. Addresses come from Uniswap's deployments feed at run time and are checked
// for code on chain. A v4 pool is the PoolKey hashed to its ID. Native ETH is the zero address
// there, so it sorts first in every pair.

export const UNISWAP_DEPLOYMENTS = "https://developers.uniswap.org/deployments.json";

const WANTED = [
  ["v2Factory", "v2", "UniswapV2Factory"],
  ["v2Router", "v2", "UniswapV2Router02"],
  ["v3Factory", "v3", "UniswapV3Factory"],
  ["v3Quoter", "v3", "QuoterV2"],
  ["v4PoolManager", "v4", "PoolManager"],
  ["v4Quoter", "v4", "V4Quoter"],
  ["v4StateView", "v4", "StateView"],
  ["v4PositionManager", "v4", "PositionManager"],
] as const;

type ContractKey = (typeof WANTED)[number][0];

export type UniswapContracts = Readonly<Record<ContractKey, Address>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The one active mainnet record for each contract the check uses on `chainId`.
export function selectUniswapContracts(json: unknown, chainId: number): UniswapContracts {
  const records = isRecord(json) && Array.isArray(json["records"]) ? json["records"] : [];
  const found: Partial<Record<ContractKey, Address>> = {};
  for (const [key, protocol, contract] of WANTED) {
    const matches = records.filter(
      (r): r is Record<string, unknown> =>
        isRecord(r) &&
        r["chainId"] === chainId &&
        r["protocol"] === protocol &&
        r["contract"] === contract &&
        r["env"] === "mainnet" &&
        r["status"] === "active",
    );
    const address = matches[0]?.["address"];
    if (matches.length !== 1 || typeof address !== "string" || !isAddress(address)) {
      throw new SourceMismatch(
        `${UNISWAP_DEPLOYMENTS} lists ${matches.length} active ${protocol} ${contract} on chain ${chainId}`,
      );
    }
    found[key] = getAddress(address);
  }
  return {
    v2Factory: required(found.v2Factory),
    v2Router: required(found.v2Router),
    v3Factory: required(found.v3Factory),
    v3Quoter: required(found.v3Quoter),
    v4PoolManager: required(found.v4PoolManager),
    v4Quoter: required(found.v4Quoter),
    v4StateView: required(found.v4StateView),
    v4PositionManager: required(found.v4PositionManager),
  };
}

function required(address: Address | undefined): Address {
  if (address === undefined) throw new SourceMismatch("a Uniswap contract is missing");
  return address;
}

// The address a token contracts page lists for `symbol`, read from the page's text.
export function addressListedFor(html: string, symbol: string): Address | null {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const match = new RegExp(`\\b${symbol}\\s+(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])`).exec(text);
  return match?.[1] === undefined ? null : getAddress(match[1]);
}

export interface Pool {
  readonly protocol: Venue;
  // A v2 pair's or v3 pool's address, or a v4 pool's ID.
  readonly id: Hex;
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number | null;
  readonly tickSpacing: number | null;
  readonly hooks: Address | null;
}

// A sale of path[0] for its last currency, through one pool per hop, all on one protocol.
export interface Route {
  readonly protocol: Venue;
  readonly path: readonly Address[];
  readonly pools: readonly Pool[];
}

export function sortPair(a: Address, b: Address): readonly [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

// The currency at `i` on a route's path.
export function hop(route: Route, i: number): Address {
  const currency = route.path[i];
  if (currency === undefined) throw new RangeError(`the route has no currency at ${i}`);
  return currency;
}

export function otherSide(pool: Pool, currency: Address): Address | null {
  if (pool.currency0 === currency) return pool.currency1;
  if (pool.currency1 === currency) return pool.currency0;
  return null;
}

export interface V4Template {
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

export function v4PoolId(currency0: Address, currency1: Address, t: V4Template): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [currency0, currency1, t.fee, t.tickSpacing, t.hooks],
    ),
  );
}

export function v4Pool(a: Address, b: Address, t: V4Template): Pool {
  const [currency0, currency1] = sortPair(a, b);
  return {
    protocol: "uniswap-v4",
    id: v4PoolId(currency0, currency1, t),
    currency0,
    currency1,
    fee: t.fee,
    tickSpacing: t.tickSpacing,
    hooks: t.hooks,
  };
}

export function leg(pool: Pool): PoolLeg {
  return {
    protocol: pool.protocol,
    pool: pool.id,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  };
}

const v2FactoryAbi = parseAbi(["function getPair(address, address) view returns (address)"]);
const v2RouterAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
]);
const v3FactoryAbi = parseAbi([
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
  "function getPool(address, address, uint24) view returns (address)",
]);
const v3PoolAbi = parseAbi(["function liquidity() view returns (uint128)"]);
const v3QuoterAbi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const v4PositionManagerAbi = parseAbi([
  "function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);
const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }",
  "struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
  "function quoteExactInput(QuoteExactParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);

function call(target: Address, data: Hex): Call {
  return { target, data };
}

export const reads = {
  getPair: (factory: Address, a: Address, b: Address): Probe<Address> => ({
    call: call(
      factory,
      encodeFunctionData({ abi: v2FactoryAbi, functionName: "getPair", args: [a, b] }),
    ),
    decode: (data) => decodeFunctionResult({ abi: v2FactoryAbi, functionName: "getPair", data }),
  }),
  feeAmountTickSpacing: (factory: Address, fee: number): Probe<number> => ({
    call: call(
      factory,
      encodeFunctionData({ abi: v3FactoryAbi, functionName: "feeAmountTickSpacing", args: [fee] }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v3FactoryAbi, functionName: "feeAmountTickSpacing", data }),
  }),
  getPool: (factory: Address, a: Address, b: Address, fee: number): Probe<Address> => ({
    call: call(
      factory,
      encodeFunctionData({ abi: v3FactoryAbi, functionName: "getPool", args: [a, b, fee] }),
    ),
    decode: (data) => decodeFunctionResult({ abi: v3FactoryAbi, functionName: "getPool", data }),
  }),
  v3Liquidity: (pool: Address): Probe<bigint> => ({
    call: call(pool, encodeFunctionData({ abi: v3PoolAbi, functionName: "liquidity" })),
    decode: (data) => decodeFunctionResult({ abi: v3PoolAbi, functionName: "liquidity", data }),
  }),
  sqrtPrice: (stateView: Address, id: Hex): Probe<bigint> => ({
    call: call(
      stateView,
      encodeFunctionData({ abi: v4StateViewAbi, functionName: "getSlot0", args: [id] }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v4StateViewAbi, functionName: "getSlot0", data })[0],
  }),
  v4Liquidity: (stateView: Address, id: Hex): Probe<bigint> => ({
    call: call(
      stateView,
      encodeFunctionData({ abi: v4StateViewAbi, functionName: "getLiquidity", args: [id] }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v4StateViewAbi, functionName: "getLiquidity", data }),
  }),
  // The key the position manager stored for a pool it has minted positions in. A pool it never
  // touched reads as all zeros.
  poolKey: (positionManager: Address, id: Hex): Probe<Pool | null> => ({
    call: call(
      positionManager,
      encodeFunctionData({
        abi: v4PositionManagerAbi,
        functionName: "poolKeys",
        args: [sliceHex(id, 0, 25)],
      }),
    ),
    decode: (data) => {
      const [currency0, currency1, fee, tickSpacing, hooks] = decodeFunctionResult({
        abi: v4PositionManagerAbi,
        functionName: "poolKeys",
        data,
      });
      if (currency1 === zeroAddress) return null;
      const pool = v4Pool(currency0, currency1, { fee, tickSpacing, hooks });
      return pool.id === id ? pool : null;
    },
  }),
};

// The USDG, or other last currency, that selling `amountIn` of path[0] through the route gets, by
// the route's protocol's own quoter.
export function quote(c: UniswapContracts, route: Route, amountIn: bigint): Probe<bigint> {
  const [first] = route.pools;
  if (first === undefined) throw new RangeError("a route needs a pool");
  switch (route.protocol) {
    case "uniswap-v2":
      return {
        call: call(
          c.v2Router,
          encodeFunctionData({
            abi: v2RouterAbi,
            functionName: "getAmountsOut",
            args: [amountIn, [...route.path]],
          }),
        ),
        decode: (data) => {
          const amounts = decodeFunctionResult({
            abi: v2RouterAbi,
            functionName: "getAmountsOut",
            data,
          });
          const out = amounts.at(-1);
          if (out === undefined) throw new RangeError("the router returned no amounts");
          return out;
        },
      };
    case "uniswap-v3":
      return route.pools.length === 1
        ? v3Single(c, route, first, amountIn)
        : v3Path(c, route, amountIn);
    case "uniswap-v4":
      return route.pools.length === 1
        ? v4Single(c, route, first, amountIn)
        : v4Path(c, route, amountIn);
  }
}

function v3Single(c: UniswapContracts, route: Route, pool: Pool, amountIn: bigint): Probe<bigint> {
  const tokenIn = hop(route, 0);
  const tokenOut = hop(route, 1);
  if (pool.fee === null) throw new RangeError("a v3 hop needs a fee");
  return {
    call: call(
      c.v3Quoter,
      encodeFunctionData({
        abi: v3QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{ tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
      }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v3QuoterAbi, functionName: "quoteExactInputSingle", data })[0],
  };
}

function v3Path(c: UniswapContracts, route: Route, amountIn: bigint): Probe<bigint> {
  const types: ("address" | "uint24")[] = ["address"];
  const values: (Address | number)[] = [hop(route, 0)];
  for (const [i, pool] of route.pools.entries()) {
    if (pool.fee === null) throw new RangeError("a v3 hop needs a fee");
    types.push("uint24", "address");
    values.push(pool.fee, hop(route, i + 1));
  }
  return {
    call: call(
      c.v3Quoter,
      encodeFunctionData({
        abi: v3QuoterAbi,
        functionName: "quoteExactInput",
        args: [encodePacked(types, values), amountIn],
      }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v3QuoterAbi, functionName: "quoteExactInput", data })[0],
  };
}

function v4Params(pool: Pool): { fee: number; tickSpacing: number; hooks: Address } {
  if (pool.fee === null || pool.tickSpacing === null || pool.hooks === null) {
    throw new RangeError("a v4 pool needs its whole key");
  }
  return { fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks };
}

function v4Single(c: UniswapContracts, route: Route, pool: Pool, amountIn: bigint): Probe<bigint> {
  const params = v4Params(pool);
  return {
    call: call(
      c.v4Quoter,
      encodeFunctionData({
        abi: v4QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: { currency0: pool.currency0, currency1: pool.currency1, ...params },
            zeroForOne: hop(route, 0) === pool.currency0,
            exactAmount: amountIn,
            hookData: "0x",
          },
        ],
      }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v4QuoterAbi, functionName: "quoteExactInputSingle", data })[0],
  };
}

function v4Path(c: UniswapContracts, route: Route, amountIn: bigint): Probe<bigint> {
  const path = route.pools.map((pool, i) => ({
    intermediateCurrency: hop(route, i + 1),
    ...v4Params(pool),
    hookData: "0x" as const,
  }));
  return {
    call: call(
      c.v4Quoter,
      encodeFunctionData({
        abi: v4QuoterAbi,
        functionName: "quoteExactInput",
        args: [{ exactCurrency: hop(route, 0), path, exactAmount: amountIn }],
      }),
    ),
    decode: (data) =>
      decodeFunctionResult({ abi: v4QuoterAbi, functionName: "quoteExactInput", data })[0],
  };
}
