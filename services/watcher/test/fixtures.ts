import assert from "node:assert/strict";
import { markets, type Market } from "@vayle/markets";
import type { Address } from "viem";
import type {
  ListedState,
  MarketSnapshot,
  MarketWatch,
  Snapshot,
  TokenState,
} from "../src/snapshot.ts";

// Wed 2026-10-07 18:00 UTC, mid trading week, with the Oct 2 boundary behind and Oct 9 ahead.
export const NOW = 1_791_396_000;
export const OCT_02 = 1_790_971_200;
export const OCT_05_OPEN = 1_791_207_000;
export const OCT_09 = 1_791_576_000;
// The Stock Tokens' access registry, as the chain facts recorded it.
export const ACCESS_REGISTRY: Address = "0xe10b6f6B275de231345c20D14Ab812db62151b00";

export function nvda(): Market {
  const found = markets.find((m) => m.symbol === "NVDA");
  assert.ok(found, "the markets file lists NVDA");
  return found;
}

// A second market built from NVDA's, with its own token and feed.
export function other(overrides: Partial<Market> = {}): Market {
  return {
    ...nvda(),
    symbol: "TWO",
    token: "0x00000000000000000000000000000000000000A1",
    feed: "0x00000000000000000000000000000000000000A2",
    ...overrides,
  };
}

export function token(overrides: Partial<TokenState> = {}): TokenState {
  return {
    paused: false,
    oraclePaused: false,
    uiMultiplier: 1_000_775_159_164_630_595n,
    newUIMultiplier: 1_000_775_159_164_630_595n,
    effectiveAt: OCT_02,
    accessRegistry: ACCESS_REGISTRY,
    accessRegistryPaused: false,
    feedUpdatedAt: NOW - 600,
    ...overrides,
  };
}

// What the market holds for an asset in the week to the Oct 9 close, with the file's caps.
export function listed(market: Market = nvda(), overrides: Partial<ListedState> = {}): ListedState {
  return {
    assetPaused: false,
    latestExpiry: OCT_09,
    caps: { sell: { ...market.sell.caps }, buy: { ...market.buy.caps } },
    ...overrides,
  };
}

export function watch(overrides: Partial<MarketWatch> = {}): MarketWatch {
  return {
    market: nvda(),
    unreadable: null,
    listing: null,
    token: token(),
    listed: listed(),
    ...overrides,
  };
}

export function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    lastSeen: NOW - 60,
    paused: false,
    haltedUntil: 0,
    latestBoundary: { close: OCT_02, creationDeadline: OCT_05_OPEN },
    nextClose: OCT_09,
    boundariesAhead: 8,
    deployedAt: OCT_02 - 7 * 86_400,
    lookback: 1800,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    block: 82_000_000n,
    now: NOW,
    usdgPaused: false,
    markets: [watch()],
    market: market(),
    ...overrides,
  };
}
