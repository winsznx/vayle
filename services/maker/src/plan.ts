import type { Address } from "viem";
import type { PricingConfig } from "./config.ts";
import { latestAnswer, type PriceReading, type PriceVerdict, type UsablePrice } from "./guard.ts";
import {
  SECONDS_PER_YEAR,
  bidPremium,
  blackScholes,
  effectiveDividendYield,
  type Side,
} from "./pricing.ts";

// What the maker does, as a pure function of what it read and its config.

export type MakerAction =
  | { readonly kind: "approve"; readonly token: Address }
  | { readonly kind: "withdraw"; readonly token: Address; readonly amount: bigint }
  | { readonly kind: "exercise"; readonly series: bigint; readonly amount: bigint }
  | {
      readonly kind: "register";
      readonly side: number;
      readonly strike: bigint;
      readonly expiry: number;
    }
  | { readonly kind: "bid"; readonly quote: QuoteTerms }
  | { readonly kind: "fill"; readonly orderId: bigint; readonly quote: QuoteTerms };

// Everything a signed quote commits to except the maker, taker (any) and nonce.
export interface QuoteTerms {
  readonly series: bigint;
  readonly premium: bigint;
  readonly maxFeeBps: number;
  readonly maxAmount: bigint;
  readonly minFill: bigint;
  readonly deadline: number;
}

export interface EpochTerms {
  readonly opening: number;
  readonly expiry: number;
  readonly batchDeadline: number;
  readonly windowLength: number;
  readonly lot: bigint;
  readonly priceTick: bigint;
  readonly rawUnit: bigint;
}

// A bucket of the current epoch with idle orders.
export interface Bucket {
  readonly side: number;
  readonly strike: bigint;
  readonly series: bigint;
  readonly registered: boolean;
  readonly bestBidder: Address | null;
  // The maker's own best bid here, which the batch may still write.
  readonly ownBid: { readonly premium: bigint; readonly amount: bigint } | null;
  readonly fillSize: bigint;
  readonly seriesRoom: bigint;
}

export interface IdleOrder {
  readonly id: bigint;
  readonly side: number;
  readonly target: bigint;
  readonly minPremium: bigint;
  readonly size: bigint;
  readonly frozen: boolean;
}

// A series the maker holds longs in.
export interface Holding {
  readonly series: bigint;
  readonly side: number;
  readonly strike: bigint;
  readonly expiry: number;
  readonly windowEnd: number;
  readonly balance: bigint;
}

export interface MakerSnapshot {
  readonly now: number;
  readonly maker: Address;
  readonly asset: Address;
  readonly usdg: Address;
  readonly usdgDecimals: number;
  readonly feeBps: number;
  readonly bidWindow: number;
  // The feed and oracle-flag reads every price comes from, before the guard judges them.
  readonly price: PriceReading;
  readonly epoch: EpochTerms | null;
  readonly buckets: readonly Bucket[];
  readonly idle: readonly IdleOrder[];
  readonly holdings: readonly Holding[];
  readonly usdgBalance: bigint;
  readonly assetBalance: bigint;
  readonly usdgAllowance: bigint;
  readonly assetAllowance: bigint;
  readonly claimableUsdg: bigint;
  readonly claimableAsset: bigint;
}

const CALL = 0;
const BPS = 10_000n;
// Allowances are topped up to the maximum once they fall below this.
export const LOW_ALLOWANCE = 1n << 128n;
// The maker stops quoting this long before expiry, and a mid-week quote lives this long.
export const RFQ_CUTOFF = 3600;
export const QUOTE_LIFETIME = 600;
const MAX_UINT = (1n << 256n) - 1n;

function floorTo(value: bigint, unit: bigint): bigint {
  return value - (value % unit);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a), MAX_UINT);
}

export function premiumFor(
  s: MakerSnapshot,
  pricing: PricingConfig,
  price: UsablePrice,
  side: number,
  strike: bigint,
): bigint | null {
  if (s.epoch === null) return null;
  const years = (s.epoch.expiry - s.now) / SECONDS_PER_YEAR;
  if (years <= 0) return null;
  const fair = blackScholes({
    side: (side === CALL ? "call" : "put") satisfies Side,
    spot: price.spot,
    strike: Number(strike) / 10 ** s.usdgDecimals,
    years,
    vol: pricing.vol,
    rate: pricing.rate,
    dividendYield: effectiveDividendYield(pricing.grossDividendYield),
  });
  return bidPremium(fair, pricing.edgeBps, s.usdgDecimals, s.epoch.priceTick);
}

// What's left to spend once the maker has kept back what exercising takes: the strike in USDG for
// every call and the asset for every put it's long in a window still to come, plus, until the
// batches are done, its own bids that a batch may still write. A long it can't exercise is a holder's
// order that doesn't fill at its price.
interface Room {
  usdg: bigint;
  asset: bigint;
}

function exerciseCost(side: number, strike: bigint, amount: bigint, rawUnit: bigint): Room {
  return side === CALL
    ? { usdg: ceilDiv(amount * strike, rawUnit), asset: 0n }
    : { usdg: 0n, asset: amount };
}

function premiumCost(premium: bigint, amount: bigint, feeBps: number, rawUnit: bigint): bigint {
  return ceilDiv(amount * premium * (BPS + BigInt(feeBps)), rawUnit * BPS);
}

function freeRoom(s: MakerSnapshot, e: EpochTerms): Room {
  const room: Room = { usdg: s.usdgBalance, asset: s.assetBalance };
  const take = (cost: Room): void => {
    room.usdg = room.usdg > cost.usdg ? room.usdg - cost.usdg : 0n;
    room.asset = room.asset > cost.asset ? room.asset - cost.asset : 0n;
  };
  for (const h of s.holdings) {
    if (s.now < h.windowEnd) take(exerciseCost(h.side, h.strike, h.balance, e.rawUnit));
  }
  if (s.now < e.batchDeadline) {
    for (const b of s.buckets) {
      if (b.ownBid === null) continue;
      take(exerciseCost(b.side, b.strike, b.ownBid.amount, e.rawUnit));
      take({
        usdg: premiumCost(b.ownBid.premium, b.ownBid.amount, s.feeBps, e.rawUnit),
        asset: 0n,
      });
    }
  }
  return room;
}

// The most `room` can buy at `premium`, fee on top, keeping back what exercising it takes, in
// whole lots.
function affordable(
  room: Room,
  side: number,
  strike: bigint,
  premium: bigint,
  feeBps: number,
  e: EpochTerms,
): bigint {
  const perRaw = premium * (BPS + BigInt(feeBps)) + (side === CALL ? strike * BPS : 0n);
  const byUsdg = perRaw === 0n ? MAX_UINT : (room.usdg * e.rawUnit * BPS) / perRaw;
  return floorTo(side === CALL ? byUsdg : min(byUsdg, room.asset), e.lot);
}

function spend(
  room: Room,
  side: number,
  strike: bigint,
  premium: bigint,
  amount: bigint,
  feeBps: number,
  e: EpochTerms,
): void {
  const cost = exerciseCost(side, strike, amount, e.rawUnit);
  const usdg = cost.usdg + premiumCost(premium, amount, feeBps, e.rawUnit);
  room.usdg = room.usdg > usdg ? room.usdg - usdg : 0n;
  room.asset = room.asset > cost.asset ? room.asset - cost.asset : 0n;
}

function housekeeping(s: MakerSnapshot): MakerAction[] {
  const actions: MakerAction[] = [];
  if (s.usdgAllowance < LOW_ALLOWANCE) actions.push({ kind: "approve", token: s.usdg });
  if (s.assetAllowance < LOW_ALLOWANCE) actions.push({ kind: "approve", token: s.asset });
  if (s.claimableUsdg > 0n)
    actions.push({ kind: "withdraw", token: s.usdg, amount: s.claimableUsdg });
  if (s.claimableAsset > 0n) {
    actions.push({ kind: "withdraw", token: s.asset, amount: s.claimableAsset });
  }
  return actions;
}

// Every in-the-money long in an open window, as far as the maker's balances pay for it, judged on
// the latest positive answer whether or not the guard passed it.
function exercises(s: MakerSnapshot): MakerAction[] {
  const spot = latestAnswer(s.price);
  if (spot === null || s.epoch === null) return [];
  const actions: MakerAction[] = [];
  let usdg = s.usdgBalance;
  let asset = s.assetBalance;
  const { lot, rawUnit } = s.epoch;
  for (const h of s.holdings) {
    if (s.now < h.expiry || s.now >= h.windowEnd) continue;
    const strike = Number(h.strike) / 10 ** s.usdgDecimals;
    const inTheMoney = h.side === CALL ? spot > strike : spot < strike;
    if (!inTheMoney) continue;
    const payable =
      h.side === CALL ? floorTo((usdg * rawUnit) / h.strike, lot) : floorTo(asset, lot);
    const amount = floorTo(min(h.balance, payable), lot);
    if (amount === 0n) continue;
    if (h.side === CALL) usdg -= (amount * h.strike) / rawUnit;
    else asset -= amount;
    actions.push({ kind: "exercise", series: h.series, amount });
  }
  return actions;
}

// Bids into each bucket's batch while the bid window is open, then registration for series that
// need it first.
function bids(s: MakerSnapshot, pricing: PricingConfig, price: UsablePrice): MakerAction[] {
  const e = s.epoch;
  if (e === null) return [];
  const opens = e.opening + e.windowLength;
  if (s.now < opens || s.now >= opens + s.bidWindow) return [];
  const actions: MakerAction[] = [];
  const room = freeRoom(s, e);
  for (const b of s.buckets) {
    if (b.bestBidder === s.maker) continue;
    if (!b.registered) {
      actions.push({ kind: "register", side: b.side, strike: b.strike, expiry: e.expiry });
      continue;
    }
    const premium = premiumFor(s, pricing, price, b.side, b.strike);
    if (premium === null) continue;
    const amount = min(
      pricing.maxPerSeries,
      affordable(room, b.side, b.strike, premium, s.feeBps, e),
    );
    const lots = floorTo(amount, e.lot);
    if (lots === 0n) continue;
    spend(room, b.side, b.strike, premium, lots, s.feeBps, e);
    actions.push({
      kind: "bid",
      quote: {
        series: b.series,
        premium,
        maxFeeBps: s.feeBps,
        maxAmount: lots,
        minFill: e.lot,
        deadline: e.expiry,
      },
    });
  }
  return actions;
}

// Mid-week quotes for orders that came in after the batch, at the same price the maker would bid.
function quotes(s: MakerSnapshot, pricing: PricingConfig, price: UsablePrice): MakerAction[] {
  const e = s.epoch;
  if (!pricing.rfq || e === null) return [];
  if (s.now < e.batchDeadline || s.now >= e.expiry - RFQ_CUTOFF) return [];
  const actions: MakerAction[] = [];
  const free = freeRoom(s, e);
  const room = new Map(s.buckets.map((b) => [b.series, b.seriesRoom]));
  for (const o of s.idle) {
    if (o.frozen) continue;
    const bucket = s.buckets.find((b) => b.side === o.side && b.strike === o.target);
    if (bucket === undefined || !bucket.registered) continue;
    const premium = premiumFor(s, pricing, price, o.side, o.target);
    if (premium === null || premium < o.minPremium) continue;
    const left = room.get(bucket.series) ?? 0n;
    const amount = floorTo(
      min(
        o.size,
        bucket.fillSize,
        left,
        pricing.maxPerSeries,
        affordable(free, o.side, o.target, premium, s.feeBps, e),
      ),
      e.lot,
    );
    if (amount === 0n) continue;
    room.set(bucket.series, left - amount);
    spend(free, o.side, o.target, premium, amount, s.feeBps, e);
    actions.push({
      kind: "fill",
      orderId: o.id,
      quote: {
        series: bucket.series,
        premium,
        maxFeeBps: s.feeBps,
        maxAmount: amount,
        minFill: amount,
        deadline: Math.min(s.now + QUOTE_LIFETIME, e.expiry),
      },
    });
  }
  return actions;
}

// Registering, bidding and quoting take on risk at a price, so they wait for a price the guard
// passed. Approving, exercising and withdrawing don't: an exercise fills a holder's order at exactly
// its price, so a wrong one only costs the maker.
export function plan(s: MakerSnapshot, pricing: PricingConfig, price: PriceVerdict): MakerAction[] {
  const priced = price.usable ? [...bids(s, pricing, price), ...quotes(s, pricing, price)] : [];
  return [...housekeeping(s), ...exercises(s), ...priced];
}
