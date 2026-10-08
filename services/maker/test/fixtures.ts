import assert from "node:assert/strict";
import { markets, type Market } from "@vayle/markets";
import type { Address } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import type { PricingConfig } from "../src/config.ts";
import type { PriceReading, PriceVerdict, StandDown, UsablePrice } from "../src/guard.ts";
import {
  LOW_ALLOWANCE,
  type Bucket,
  type EpochTerms,
  type Holding,
  type IdleOrder,
  type MakerSnapshot,
  type MarketState,
} from "../src/plan.ts";

// Snapshots for the maker's plan and bid sheet: NVDA from the markets file in the week from the
// Oct 2 close to the Oct 9 close, and a second market built from NVDA's.

export const MAKER = "0x000000000000000000000000000000000000beef";
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const ONE = 10n ** 18n;
export const LOT = 10n ** 16n;
export const OCT_02 = 1_790_971_200;
export const OCT_09 = 1_791_576_000;
export const DEADLINE = 1_791_207_000 - 48_600;
export const BID_OPEN = OCT_02 + 7200;
export const WEDNESDAY = 1_791_374_400;
export const CALL_STRIKE = 245_000_000n;
export const PUT_STRIKE = 230_000_000n;
export const FEED_DECIMALS = facts.nvdaUsdFeed.decimals;

export function nvda(): Market {
  const found = markets.find((m) => m.symbol === "NVDA");
  assert.ok(found, "the markets file lists NVDA");
  return found;
}

export const NVDA = nvda().token;
// A second market built from NVDA's, with its own token and feed.
export const OTHER: Address = "0x00000000000000000000000000000000000000A1";
export function other(overrides: Partial<Market> = {}): Market {
  return {
    ...nvda(),
    symbol: "TWO",
    token: OTHER,
    feed: "0x00000000000000000000000000000000000000A2",
    ...overrides,
  };
}

// What the guard hands the plan when the price is fine, and when it isn't.
export const PRICE: UsablePrice = { usable: true, spot: 240, roundId: 1n, updatedAt: OCT_02 };
export const STOOD_DOWN: StandDown = {
  usable: false,
  reason: "OraclePaused",
  detail: "the token's oracle is paused",
};

export function prices(
  ...entries: (readonly [Address, PriceVerdict])[]
): Map<Address, PriceVerdict> {
  return new Map(entries.length === 0 ? [[NVDA, PRICE]] : entries);
}

// The feed's reads with a latest answer of `usd` dollars.
export function answered(usd: bigint): PriceReading {
  return {
    round: {
      ok: true,
      value: { roundId: 1n, answer: usd * 10n ** BigInt(FEED_DECIMALS), updatedAt: OCT_02 },
    },
    feedDecimals: { ok: true, value: FEED_DECIMALS },
    oraclePaused: { ok: true, value: false },
    reference: 240_000_000n,
  };
}

// A close's answer of `usd` dollars, in the feed's decimals.
export function dollars(usd: bigint): bigint {
  return usd * 10n ** BigInt(FEED_DECIMALS);
}

export const pricing: PricingConfig = {
  grossDividendYield: 0.0002,
  rate: 0.04,
  edgeBps: 2000,
  rfq: true,
};

export const WEEK: EpochTerms = {
  opening: OCT_02,
  expiry: OCT_09,
  batchDeadline: DEADLINE,
  windowLength: 7200,
  lot: LOT,
  priceTick: 100n,
  rawUnit: ONE,
  referencePrice: 240_000_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
};

export function bucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    side: 0,
    strike: CALL_STRIKE,
    series: 11n,
    registered: true,
    bestBidder: null,
    ownBid: null,
    fillSize: 2n * ONE,
    written: 0n,
    seriesRoom: 6n * ONE,
    ...overrides,
  };
}

export function state(overrides: Partial<MarketState> = {}): MarketState {
  return {
    market: nvda(),
    price: answered(240n),
    epoch: WEEK,
    buckets: [],
    balance: 10n * ONE,
    allowance: LOW_ALLOWANCE,
    claimable: 0n,
    closes: new Map(),
    ...overrides,
  };
}

export function snapshot(overrides: Partial<MakerSnapshot> = {}): MakerSnapshot {
  return {
    block: 82_900_000n,
    now: WEDNESDAY,
    maker: MAKER,
    usdg: USDG,
    usdgDecimals: 6,
    feeBps: 0,
    bidWindow: 7200,
    markets: [state()],
    idle: [],
    holdings: [],
    usdgBalance: 100_000n * 10n ** 6n,
    usdgAllowance: LOW_ALLOWANCE,
    claimableUsdg: 0n,
    ...overrides,
  };
}

export function idleOrder(id: bigint, overrides: Partial<IdleOrder> = {}): IdleOrder {
  return {
    id,
    asset: NVDA,
    side: 0,
    target: CALL_STRIKE,
    minPremium: 100n,
    size: ONE,
    frozen: false,
    ...overrides,
  };
}

// A long the maker holds in the week that ended at the Oct 2 close, its window still open.
export function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    series: 1n,
    asset: NVDA,
    side: 0,
    strike: CALL_STRIKE,
    expiry: OCT_02,
    windowEnd: OCT_02 + 7200,
    balance: ONE,
    ...overrides,
  };
}
