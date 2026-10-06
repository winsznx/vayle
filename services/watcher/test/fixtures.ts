import type { MarketSnapshot, Snapshot } from "../src/snapshot.ts";

// Wed 2026-10-07 18:00 UTC, mid trading week, with the Oct 2 boundary behind and Oct 9 ahead.
export const NOW = 1_791_396_000;
export const OCT_02 = 1_790_971_200;
export const OCT_05_OPEN = 1_791_207_000;
export const OCT_09 = 1_791_576_000;

export function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    lastSeen: NOW - 60,
    paused: false,
    assetPaused: false,
    haltedUntil: 0,
    latestBoundary: { close: OCT_02, creationDeadline: OCT_05_OPEN },
    nextClose: OCT_09,
    boundariesAhead: 8,
    epochOpenedAtLatest: true,
    ...overrides,
  };
}

export function snapshot(
  overrides: Partial<Omit<Snapshot, "issuer">> & { issuer?: Partial<Snapshot["issuer"]> } = {},
): Snapshot {
  const { issuer, ...rest } = overrides;
  return {
    block: 82_000_000n,
    now: NOW,
    feedUpdatedAt: NOW - 600,
    market: market(),
    ...rest,
    issuer: {
      nvdaPaused: false,
      accessRegistryPaused: false,
      usdgPaused: false,
      oraclePaused: false,
      uiMultiplier: 1_000_775_159_164_630_595n,
      newUIMultiplier: 1_000_775_159_164_630_595n,
      effectiveAt: OCT_02,
      ...issuer,
    },
  };
}
