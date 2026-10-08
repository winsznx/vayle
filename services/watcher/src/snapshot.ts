import {
  livenessCheckpointAbi,
  sessionCalendarAbi,
  stockTokenRegistryAbi,
  vayleMarketAbi,
} from "@vayle/abi";
import { errorText } from "@vayle/chain-facts/rpc-errors";
import { listingDifferences, type Listing, type Market } from "@vayle/markets";
import {
  AbiDecodingDataSizeTooSmallError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  parseAbi,
  type Address,
  type ContractFunctionReturnType,
  type PublicClient,
} from "viem";
import type { MarketAddresses, WatcherConfig } from "./config.ts";

const stockTokenAbi = parseAbi([
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
]);
const pausableAbi = parseAbi(["function paused() view returns (bool)"]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const CALL = 0;
const PUT = 1;

// Boundaries read per Multicall3 call, newest first. The deploy schedules ten weeks and the
// timelock tops the calendar up, so one call covers more than a year ahead.
export const BOUNDARY_WINDOW = 64;

export type Caps = ContractFunctionReturnType<typeof vayleMarketAbi, "view", "capsOf">;

// What a Stock Token and its feed report: the issuer's side of one market.
export interface TokenState {
  readonly paused: boolean;
  readonly oraclePaused: boolean;
  readonly uiMultiplier: bigint;
  readonly newUIMultiplier: bigint;
  readonly effectiveAt: number;
  // The access registry the token checks transfers against, and whether it's paused.
  readonly accessRegistry: Address;
  readonly accessRegistryPaused: boolean;
  readonly feedUpdatedAt: number;
}

// What the market holds for one of its assets, once it's deployed.
export interface ListedState {
  readonly assetPaused: boolean;
  // 0 before the asset's first week.
  readonly latestExpiry: number;
  readonly caps: { readonly sell: Caps; readonly buy: Caps };
}

// One market from the markets file, as far as this run could read it.
export interface MarketWatch {
  readonly market: Market;
  // Why its contracts couldn't be read this run, or null.
  readonly unreadable: string | null;
  // How its listing in the token registry differs from the markets file, or null. Always null
  // before the market is deployed.
  readonly listing: string | null;
  // Null when unreadable.
  readonly token: TokenState | null;
  // Null when unreadable or before the market is deployed.
  readonly listed: ListedState | null;
}

export interface Boundary {
  readonly close: number;
  readonly creationDeadline: number;
}

export interface MarketSnapshot {
  readonly lastSeen: number;
  readonly paused: boolean;
  // When the active halt ends, or 0.
  readonly haltedUntil: number;
  readonly latestBoundary: Boundary | null;
  readonly nextClose: number | null;
  readonly boundariesAhead: number;
  // When the market was deployed, and the liveness lookback a first week needs after it.
  readonly deployedAt: number;
  readonly lookback: number;
}

export interface Snapshot {
  readonly block: bigint;
  readonly now: number;
  readonly usdgPaused: boolean;
  readonly markets: readonly MarketWatch[];
  readonly market: MarketSnapshot | null;
}

export interface CalendarPosition {
  readonly latestBoundary: Boundary | null;
  readonly nextClose: number | null;
  readonly boundariesAhead: number;
}

// Where `now` falls in a calendar of `count` boundaries, walking back from the last one a window at
// a time: the latest boundary at or before now, the first close after it, and how many closes lie
// ahead. The calendar only ever holds a few weeks ahead, so the walk is short. `read` answers the
// boundaries at the indexes asked, in the same order.
export async function walkBoundaries(
  count: bigint,
  now: number,
  read: (indexes: readonly bigint[]) => Promise<readonly Boundary[]>,
): Promise<CalendarPosition> {
  let boundariesAhead = 0;
  let nextClose: number | null = null;
  const window = BigInt(BOUNDARY_WINDOW);
  let top = count;
  while (top > 0n) {
    const bottom = top > window ? top - window : 0n;
    const indexes: bigint[] = [];
    for (let index = top - 1n; index >= bottom; index--) indexes.push(index);
    for (const boundary of await read(indexes)) {
      if (boundary.close > now) {
        boundariesAhead++;
        nextClose = boundary.close;
        continue;
      }
      return { latestBoundary: boundary, nextClose, boundariesAhead };
    }
    top = bottom;
  }
  return { latestBoundary: null, nextClose, boundariesAhead };
}

// Whether a read failed at its contract, by reverting or with an answer its ABI can't decode, as
// opposed to its request failing. A failed request takes every read in it, every market's
// included, so only a refusal is pinned on one market and the others are still watched.
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

type Refusable<T> = { readonly value: T; readonly refusal: null } | { readonly refusal: string };

async function refusable<T>(read: Promise<T>): Promise<Refusable<T>> {
  try {
    return { value: await read, refusal: null };
  } catch (error) {
    if (refused(error)) return { refusal: errorText(error) };
    throw error;
  }
}

// How a market's listing in the token registry differs from the markets file, or null when it
// doesn't.
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

async function readToken(
  client: PublicClient,
  m: Market,
  blockNumber: bigint,
): Promise<Omit<TokenState, "accessRegistryPaused">> {
  const token = { address: m.token, abi: stockTokenAbi, blockNumber } as const;
  const [paused, oraclePaused, uiMultiplier, newUIMultiplier, effectiveAt, registry, round] =
    await Promise.all([
      client.readContract({ ...token, functionName: "paused" }),
      client.readContract({ ...token, functionName: "oraclePaused" }),
      client.readContract({ ...token, functionName: "uiMultiplier" }),
      client.readContract({ ...token, functionName: "newUIMultiplier" }),
      client.readContract({ ...token, functionName: "effectiveAt" }),
      client.readContract({ ...token, functionName: "ACCESS_CONTROLLED_REGISTRY" }),
      client.readContract({
        address: m.feed,
        abi: feedAbi,
        functionName: "latestRoundData",
        blockNumber,
      }),
    ]);
  return {
    paused,
    oraclePaused,
    uiMultiplier,
    newUIMultiplier,
    effectiveAt: Number(effectiveAt),
    accessRegistry: getAddress(registry),
    feedUpdatedAt: Number(round[3]),
  };
}

async function readListed(
  client: PublicClient,
  addresses: MarketAddresses,
  m: Market,
  blockNumber: bigint,
): Promise<ListedState> {
  const market = { address: addresses.market, abi: vayleMarketAbi, blockNumber } as const;
  const [assetPaused, latestExpiry, sell, buy] = await Promise.all([
    client.readContract({ ...market, functionName: "assetPaused", args: [m.token] }),
    client.readContract({ ...market, functionName: "latestExpiry", args: [m.token] }),
    client.readContract({ ...market, functionName: "capsOf", args: [m.token, CALL] }),
    client.readContract({ ...market, functionName: "capsOf", args: [m.token, PUT] }),
  ]);
  return { assetPaused, latestExpiry: Number(latestExpiry), caps: { sell, buy } };
}

// Every read is pinned to the latest block. The tokens', the feeds' and the market's reads start
// together, so the client sends them as one Multicall3 call, every market's in it. The access
// registries the tokens name and the calendar's boundaries follow in a second.
export async function readSnapshot(client: PublicClient, config: WatcherConfig): Promise<Snapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const addresses = config.market;
  const [usdgPaused, perMarket, market] = await Promise.all([
    client.readContract({
      address: config.usdg,
      abi: pausableAbi,
      functionName: "paused",
      blockNumber,
    }),
    Promise.all(
      config.markets.map(async (m) => {
        const [token, listed, listing] = await Promise.all([
          refusable(readToken(client, m, blockNumber)),
          addresses === null ? null : refusable(readListed(client, addresses, m, blockNumber)),
          addresses === null
            ? null
            : listingProblem(
                m,
                client.readContract({
                  address: addresses.registry,
                  abi: stockTokenRegistryAbi,
                  functionName: "asset",
                  args: [m.token],
                  blockNumber,
                }),
              ),
        ]);
        return { market: m, token, listed, listing };
      }),
    ),
    addresses === null ? null : readMarketGetters(client, addresses, blockNumber),
  ]);

  // The second call: each access registry the tokens name, once, and the calendar's boundaries.
  const registryReads = new Map<Address, Promise<Refusable<boolean>>>();
  const registryPaused = (address: Address): Promise<Refusable<boolean>> => {
    const started = registryReads.get(address);
    if (started !== undefined) return started;
    const read = refusable(
      client.readContract({ address, abi: pausableAbi, functionName: "paused", blockNumber }),
    );
    registryReads.set(address, read);
    return read;
  };
  const [position, registries] = await Promise.all([
    addresses === null || market === null
      ? null
      : readPosition(client, addresses, market.boundaryCount, now, blockNumber),
    Promise.all(
      perMarket.map(async ({ token }) =>
        token.refusal === null ? registryPaused(token.value.accessRegistry) : null,
      ),
    ),
  ]);

  const markets = perMarket.map(({ market: m, token, listed, listing }, i): MarketWatch => {
    const unreadable = (reason: string): MarketWatch => ({
      market: m,
      unreadable: reason,
      listing: null,
      token: null,
      listed: null,
    });
    if (token.refusal !== null)
      return unreadable(`its token or feed couldn't be read: ${token.refusal}`);
    const registry = registries[i] ?? null;
    if (registry === null) return unreadable("its access registry wasn't read");
    if (registry.refusal !== null) {
      return unreadable(`its access registry couldn't be read: ${registry.refusal}`);
    }
    if (listed !== null && listed.refusal !== null) {
      return unreadable(`the market's reads for it failed: ${listed.refusal}`);
    }
    return {
      market: m,
      unreadable: null,
      listing,
      token: { ...token.value, accessRegistryPaused: registry.value },
      listed: listed === null ? null : listed.value,
    };
  });
  return {
    block: blockNumber,
    now,
    usdgPaused,
    markets,
    market:
      market === null || position === null
        ? null
        : {
            lastSeen: market.lastSeen,
            paused: market.paused,
            haltedUntil: market.haltedUntil,
            deployedAt: market.deployedAt,
            lookback: market.lookback,
            ...position,
          },
  };
}

async function readMarketGetters(
  client: PublicClient,
  addresses: MarketAddresses,
  blockNumber: bigint,
) {
  const market = { address: addresses.market, abi: vayleMarketAbi, blockNumber } as const;
  const [lastSeen, paused, haltedUntil, deployedAt, lookback, boundaryCount] = await Promise.all([
    client.readContract({
      address: addresses.liveness,
      abi: livenessCheckpointAbi,
      functionName: "lastSeen",
      blockNumber,
    }),
    client.readContract({ ...market, functionName: "paused" }),
    client.readContract({ ...market, functionName: "haltedUntil" }),
    client.readContract({ ...market, functionName: "deployedAt" }),
    client.readContract({ ...market, functionName: "LIVENESS_LOOKBACK" }),
    client.readContract({
      address: addresses.calendar,
      abi: sessionCalendarAbi,
      functionName: "boundaryCount",
      blockNumber,
    }),
  ]);
  return {
    lastSeen: Number(lastSeen),
    paused,
    haltedUntil: Number(haltedUntil),
    deployedAt: Number(deployedAt),
    lookback: Number(lookback),
    boundaryCount,
  };
}

function readPosition(
  client: PublicClient,
  addresses: MarketAddresses,
  count: bigint,
  now: number,
  blockNumber: bigint,
): Promise<CalendarPosition> {
  const calendar = { address: addresses.calendar, abi: sessionCalendarAbi, blockNumber } as const;
  return walkBoundaries(count, now, (indexes) =>
    Promise.all(
      indexes.map(async (index) => {
        const b = await client.readContract({
          ...calendar,
          functionName: "boundaryAt",
          args: [index],
        });
        return { close: Number(b.close), creationDeadline: Number(b.creationDeadline) };
      }),
    ),
  );
}
