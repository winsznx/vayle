import { sessionCalendarAbi, livenessCheckpointAbi, vayleMarketAbi } from "@vayle/abi";
import { parseAbi, type PublicClient } from "viem";
import type { MarketAddresses, WatcherConfig } from "./config.ts";

const stockTokenAbi = parseAbi([
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);
const pausableAbi = parseAbi(["function paused() view returns (bool)"]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

// Boundaries read per Multicall3 call, newest first. The deploy schedules ten weeks and the
// timelock tops the calendar up, so one call covers more than a year ahead.
export const BOUNDARY_WINDOW = 64;

export interface IssuerSnapshot {
  readonly nvdaPaused: boolean;
  readonly accessRegistryPaused: boolean;
  readonly usdgPaused: boolean;
  readonly oraclePaused: boolean;
  readonly uiMultiplier: bigint;
  readonly newUIMultiplier: bigint;
  readonly effectiveAt: number;
}

export interface Boundary {
  readonly close: number;
  readonly creationDeadline: number;
}

export interface MarketSnapshot {
  readonly lastSeen: number;
  readonly paused: boolean;
  readonly assetPaused: boolean;
  // When the active halt ends, or 0.
  readonly haltedUntil: number;
  readonly latestBoundary: Boundary | null;
  readonly nextClose: number | null;
  readonly boundariesAhead: number;
  // Whether an NVDA epoch opened at the latest boundary.
  readonly epochOpenedAtLatest: boolean;
}

export interface Snapshot {
  readonly block: bigint;
  readonly now: number;
  readonly issuer: IssuerSnapshot;
  readonly feedUpdatedAt: number;
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

// Every read is pinned to the latest block, and the issuer's and the market's reads start together,
// so the client sends them as one Multicall3 call.
export async function readSnapshot(client: PublicClient, config: WatcherConfig): Promise<Snapshot> {
  const block = await client.getBlock({ blockTag: "latest" });
  const blockNumber = block.number;
  const now = Number(block.timestamp);
  const nvda = { address: config.nvda, abi: stockTokenAbi, blockNumber } as const;
  const [
    nvdaPaused,
    oraclePaused,
    uiMultiplier,
    newUIMultiplier,
    effectiveAt,
    accessRegistryPaused,
    usdgPaused,
    round,
    market,
  ] = await Promise.all([
    client.readContract({ ...nvda, functionName: "paused" }),
    client.readContract({ ...nvda, functionName: "oraclePaused" }),
    client.readContract({ ...nvda, functionName: "uiMultiplier" }),
    client.readContract({ ...nvda, functionName: "newUIMultiplier" }),
    client.readContract({ ...nvda, functionName: "effectiveAt" }),
    client.readContract({
      address: config.nvdaAccessRegistry,
      abi: pausableAbi,
      functionName: "paused",
      blockNumber,
    }),
    client.readContract({
      address: config.usdg,
      abi: pausableAbi,
      functionName: "paused",
      blockNumber,
    }),
    client.readContract({
      address: config.nvdaFeed,
      abi: feedAbi,
      functionName: "latestRoundData",
      blockNumber,
    }),
    config.market === null
      ? null
      : readMarket(client, config.market, config.nvda, blockNumber, now),
  ]);
  return {
    block: blockNumber,
    now,
    issuer: {
      nvdaPaused,
      accessRegistryPaused,
      usdgPaused,
      oraclePaused,
      uiMultiplier,
      newUIMultiplier,
      effectiveAt: Number(effectiveAt),
    },
    feedUpdatedAt: Number(round[3]),
    market,
  };
}

async function readMarket(
  client: PublicClient,
  addresses: MarketAddresses,
  asset: `0x${string}`,
  blockNumber: bigint,
  now: number,
): Promise<MarketSnapshot> {
  const market = { address: addresses.market, abi: vayleMarketAbi, blockNumber } as const;
  const calendar = { address: addresses.calendar, abi: sessionCalendarAbi, blockNumber } as const;
  const [lastSeen, paused, assetPaused, haltedUntil, latestExpiry, count] = await Promise.all([
    client.readContract({
      address: addresses.liveness,
      abi: livenessCheckpointAbi,
      functionName: "lastSeen",
      blockNumber,
    }),
    client.readContract({ ...market, functionName: "paused" }),
    client.readContract({ ...market, functionName: "assetPaused", args: [asset] }),
    client.readContract({ ...market, functionName: "haltedUntil" }),
    client.readContract({ ...market, functionName: "latestExpiry", args: [asset] }),
    client.readContract({ ...calendar, functionName: "boundaryCount" }),
  ]);
  const { latestBoundary, nextClose, boundariesAhead } = await walkBoundaries(
    count,
    now,
    (indexes) =>
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
  return {
    lastSeen: Number(lastSeen),
    paused,
    assetPaused,
    haltedUntil: Number(haltedUntil),
    latestBoundary,
    nextClose,
    boundariesAhead,
    epochOpenedAtLatest: latestBoundary !== null && Number(latestExpiry) > latestBoundary.close,
  };
}
