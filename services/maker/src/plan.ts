import type { Market } from "@vayle/markets";
import type { Address } from "viem";
import type { PricingConfig } from "./config.ts";
import type { PriceReading, PriceVerdict, UsablePrice } from "./guard.ts";
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
      readonly asset: Address;
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
  // The grid the week lists its targets on.
  readonly referencePrice: bigint;
  readonly strikeTick: bigint;
  readonly strikeRangeBps: number;
}

// A target the current epoch lists, on a side the market trades.
export interface Bucket {
  readonly side: number;
  readonly strike: bigint;
  readonly series: bigint;
  readonly registered: boolean;
  readonly bestBidder: Address | null;
  // The maker's own best bid here, which the batch may still write.
  readonly ownBid: { readonly premium: bigint; readonly amount: bigint } | null;
  readonly fillSize: bigint;
  // What the series has written, and the room left under the cap the market holds for it.
  readonly written: bigint;
  readonly seriesRoom: bigint;
}

export interface IdleOrder {
  readonly id: bigint;
  readonly asset: Address;
  readonly side: number;
  readonly target: bigint;
  readonly minPremium: bigint;
  readonly size: bigint;
  readonly frozen: boolean;
}

// A series the maker holds longs in.
export interface Holding {
  readonly series: bigint;
  readonly asset: Address;
  readonly side: number;
  readonly strike: bigint;
  readonly expiry: number;
  readonly windowEnd: number;
  readonly balance: bigint;
}

// One market from the markets file whose listing in the token registry matches the file.
export interface MarketState {
  readonly market: Market;
  // The feed and oracle-flag reads its prices come from, before the guard judges them.
  readonly price: PriceReading;
  readonly epoch: EpochTerms | null;
  readonly buckets: readonly Bucket[];
  // The maker's wallet balance of the token, its allowance to the market, and what the market holds
  // for it to withdraw.
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly claimable: bigint;
  // The feed's answer at the close each held series with an open window expired at, or null when no
  // round at or before that close was found.
  readonly closes: ReadonlyMap<number, bigint | null>;
}

export interface MakerSnapshot {
  readonly block: bigint;
  readonly now: number;
  readonly maker: Address;
  readonly usdg: Address;
  readonly usdgDecimals: number;
  readonly feeBps: number;
  readonly bidWindow: number;
  readonly markets: readonly MarketState[];
  readonly idle: readonly IdleOrder[];
  readonly holdings: readonly Holding[];
  readonly usdgBalance: bigint;
  readonly usdgAllowance: bigint;
  readonly claimableUsdg: bigint;
}

// Each market's verdict on its price, by token.
export type Prices = ReadonlyMap<Address, PriceVerdict>;

const CALL = 0;
const BPS = 10_000n;
// Allowances are topped up to the maximum once they fall below this.
export const LOW_ALLOWANCE = 1n << 128n;
// The maker stops quoting this long before expiry, and a mid-week quote lives this long.
export const RFQ_CUTOFF = 3600;
export const QUOTE_LIFETIME = 600;
export const MAX_UINT = (1n << 256n) - 1n;

function floorTo(value: bigint, unit: bigint): bigint {
  return value - (value % unit);
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function min(...values: bigint[]): bigint {
  return values.reduce((a, b) => (b < a ? b : a), MAX_UINT);
}

// The markets file's terms for a side: sell targets are calls, buy targets puts.
function sideOf(market: Market, side: number): Market["sell"] {
  return side === CALL ? market.sell : market.buy;
}

export function premiumFor(
  s: Pick<MakerSnapshot, "now" | "usdgDecimals">,
  m: MarketState,
  pricing: PricingConfig,
  price: UsablePrice,
  side: number,
  strike: bigint,
): bigint | null {
  if (m.epoch === null) return null;
  const years = (m.epoch.expiry - s.now) / SECONDS_PER_YEAR;
  if (years <= 0) return null;
  const fair = blackScholes({
    side: (side === CALL ? "call" : "put") satisfies Side,
    spot: price.spot,
    strike: Number(strike) / 10 ** s.usdgDecimals,
    years,
    vol: m.market.maker.volBps / 10_000,
    rate: pricing.rate,
    dividendYield: effectiveDividendYield(pricing.grossDividendYield),
  });
  return bidPremium(fair, pricing.edgeBps, s.usdgDecimals, m.epoch.priceTick);
}

// What's left to spend once the maker has kept back what exercising takes: the strike in USDG for
// every call and the token for every put it's long in a window still to come, plus, until each
// week's batches are done, its own bids that a batch may still write. A long it can't exercise is a
// holder's order that doesn't fill at its price. USDG is one pool for every market. A market's
// token counts what the maker holds and what the market holds for it to withdraw.
export interface Room {
  usdg: bigint;
  readonly tokens: Map<Address, bigint>;
}

interface Cost {
  readonly usdg: bigint;
  readonly token: bigint;
}

function exerciseCost(side: number, strike: bigint, amount: bigint, rawUnit: bigint): Cost {
  return side === CALL
    ? { usdg: ceilDiv(amount * strike, rawUnit), token: 0n }
    : { usdg: 0n, token: amount };
}

function premiumCost(premium: bigint, amount: bigint, feeBps: number, rawUnit: bigint): bigint {
  return ceilDiv(amount * premium * (BPS + BigInt(feeBps)), rawUnit * BPS);
}

function take(room: Room, token: Address, cost: Cost): void {
  room.usdg = room.usdg > cost.usdg ? room.usdg - cost.usdg : 0n;
  const held = room.tokens.get(token) ?? 0n;
  room.tokens.set(token, held > cost.token ? held - cost.token : 0n);
}

export function freeRoom(s: MakerSnapshot): Room {
  const room: Room = {
    usdg: s.usdgBalance,
    tokens: new Map(s.markets.map((m) => [m.market.token, m.balance + m.claimable])),
  };
  for (const h of s.holdings) {
    const m = s.markets.find((x) => x.market.token === h.asset);
    if (m === undefined || s.now >= h.windowEnd) continue;
    take(room, h.asset, exerciseCost(h.side, h.strike, h.balance, m.market.rawUnit));
  }
  for (const m of s.markets) {
    const e = m.epoch;
    if (e === null || s.now >= e.batchDeadline) continue;
    for (const b of m.buckets) {
      if (b.ownBid === null) continue;
      take(room, m.market.token, exerciseCost(b.side, b.strike, b.ownBid.amount, e.rawUnit));
      take(room, m.market.token, {
        usdg: premiumCost(b.ownBid.premium, b.ownBid.amount, s.feeBps, e.rawUnit),
        token: 0n,
      });
    }
  }
  return room;
}

// The most `room` can buy at `premium`, fee on top, keeping back what exercising it takes, in
// whole lots. A put takes the market's token to exercise, so its size is what the maker holds of it.
function affordable(
  room: Room,
  token: Address,
  side: number,
  strike: bigint,
  premium: bigint,
  feeBps: number,
  e: EpochTerms,
): bigint {
  const perRaw = premium * (BPS + BigInt(feeBps)) + (side === CALL ? strike * BPS : 0n);
  const byUsdg = perRaw === 0n ? MAX_UINT : (room.usdg * e.rawUnit * BPS) / perRaw;
  return floorTo(side === CALL ? byUsdg : min(byUsdg, room.tokens.get(token) ?? 0n), e.lot);
}

function spend(
  room: Room,
  token: Address,
  side: number,
  strike: bigint,
  premium: bigint,
  amount: bigint,
  feeBps: number,
  e: EpochTerms,
): void {
  const cost = exerciseCost(side, strike, amount, e.rawUnit);
  take(room, token, {
    usdg: cost.usdg + premiumCost(premium, amount, feeBps, e.rawUnit),
    token: cost.token,
  });
}

// What the series can still take from the maker: the room under the cap the market holds for it,
// and under the open interest the markets file sets for the side, whichever is less.
export function seriesLeft(m: MarketState, b: Bucket): bigint {
  const cap = sideOf(m.market, b.side).caps.seriesOpenInterest;
  return min(b.seriesRoom, cap > b.written ? cap - b.written : 0n);
}

// The most the maker buys from one order of `size` at `premium` right now, in whole lots: within one
// fill's cap, what the series can still take, and what its balances cover after what they're kept
// for. The bid sheet asks with no order size.
export function quoteSize(
  s: Pick<MakerSnapshot, "feeBps">,
  m: MarketState,
  e: EpochTerms,
  b: Bucket,
  room: Room,
  premium: bigint,
  size: bigint,
  left: bigint,
): bigint {
  return floorTo(
    min(
      size,
      b.fillSize,
      left,
      affordable(room, m.market.token, b.side, b.strike, premium, s.feeBps, e),
    ),
    e.lot,
  );
}

// Whether the maker quotes new orders in this week right now: from the batch deadline, which in a
// market's first week is its opening, until an hour before expiry.
export function quoting(
  s: Pick<MakerSnapshot, "now">,
  pricing: PricingConfig,
  e: EpochTerms,
): boolean {
  return pricing.rfq && s.now >= e.batchDeadline && s.now < e.expiry - RFQ_CUTOFF;
}

export function tradesSide(m: MarketState, side: number): boolean {
  return sideOf(m.market, side).enabled;
}

function usablePrice(prices: Prices, m: MarketState): UsablePrice | null {
  const verdict = prices.get(m.market.token);
  return verdict?.usable === true ? verdict : null;
}

function housekeeping(s: MakerSnapshot): MakerAction[] {
  const actions: MakerAction[] = [];
  if (s.usdgAllowance < LOW_ALLOWANCE) actions.push({ kind: "approve", token: s.usdg });
  for (const m of s.markets) {
    if (m.allowance < LOW_ALLOWANCE) actions.push({ kind: "approve", token: m.market.token });
  }
  if (s.claimableUsdg > 0n) {
    actions.push({ kind: "withdraw", token: s.usdg, amount: s.claimableUsdg });
  }
  for (const m of s.markets) {
    if (m.claimable > 0n) {
      actions.push({ kind: "withdraw", token: m.market.token, amount: m.claimable });
    }
  }
  return actions;
}

// Whether a holding finished past its strike at its close: the feed's last round at or before the
// series' expiry, strictly past the strike, compared exactly in integers. A week's fill is decided
// by its close, so the price in the window after it changes nothing.
function inTheMoneyAtClose(m: MarketState, h: Holding, usdgDecimals: number): boolean {
  const close = m.closes.get(h.expiry) ?? null;
  const { feedDecimals } = m.price;
  if (close === null || close <= 0n || !feedDecimals.ok) return false;
  const answer = close * 10n ** BigInt(usdgDecimals);
  const strike = h.strike * 10n ** BigInt(feedDecimals.value);
  return h.side === CALL ? answer > strike : answer < strike;
}

// Every long in an open window that finished in the money at its close, as far as the maker's
// balances pay for it, whether or not the guard passed the latest price.
function exercises(s: MakerSnapshot): MakerAction[] {
  const actions: MakerAction[] = [];
  let usdg = s.usdgBalance;
  const tokens = new Map(s.markets.map((m) => [m.market.token, m.balance]));
  for (const h of s.holdings) {
    if (s.now < h.expiry || s.now >= h.windowEnd) continue;
    const m = s.markets.find((x) => x.market.token === h.asset);
    if (m === undefined || !inTheMoneyAtClose(m, h, s.usdgDecimals)) continue;
    const { lot, rawUnit } = m.market;
    const held = tokens.get(h.asset) ?? 0n;
    const payable =
      h.side === CALL ? floorTo((usdg * rawUnit) / h.strike, lot) : floorTo(held, lot);
    const amount = floorTo(min(h.balance, payable), lot);
    if (amount === 0n) continue;
    if (h.side === CALL) usdg -= (amount * h.strike) / rawUnit;
    else tokens.set(h.asset, held - amount);
    actions.push({ kind: "exercise", series: h.series, amount });
  }
  return actions;
}

// Bids into each bucket's batch while its bid window is open, then registration for series that
// need it first. The window closes at the batch deadline, so a first week, whose deadline is its
// opening, has none.
function bids(s: MakerSnapshot, pricing: PricingConfig, prices: Prices, room: Room): MakerAction[] {
  const actions: MakerAction[] = [];
  for (const m of s.markets) {
    const e = m.epoch;
    const price = usablePrice(prices, m);
    if (e === null || price === null) continue;
    const opens = e.opening + e.windowLength;
    if (s.now < opens || s.now >= Math.min(opens + s.bidWindow, e.batchDeadline)) continue;
    for (const b of m.buckets) {
      if (!tradesSide(m, b.side) || b.bestBidder === s.maker) continue;
      const waiting = s.idle.some(
        (o) => o.asset === m.market.token && o.side === b.side && o.target === b.strike,
      );
      if (!waiting) continue;
      if (!b.registered) {
        actions.push({
          kind: "register",
          asset: m.market.token,
          side: b.side,
          strike: b.strike,
          expiry: e.expiry,
        });
        continue;
      }
      const premium = premiumFor(s, m, pricing, price, b.side, b.strike);
      if (premium === null) continue;
      const cap = sideOf(m.market, b.side).caps.seriesOpenInterest;
      const lots = floorTo(
        min(
          cap > b.written ? cap - b.written : 0n,
          affordable(room, m.market.token, b.side, b.strike, premium, s.feeBps, e),
        ),
        e.lot,
      );
      if (lots === 0n) continue;
      spend(room, m.market.token, b.side, b.strike, premium, lots, s.feeBps, e);
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
  }
  return actions;
}

// Mid-week quotes for orders that came in after the batch, at the same price the maker would bid.
// A series nobody has registered yet is registered on one run and quoted on the next.
function quotes(
  s: MakerSnapshot,
  pricing: PricingConfig,
  prices: Prices,
  room: Room,
): MakerAction[] {
  const actions: MakerAction[] = [];
  for (const m of s.markets) {
    const e = m.epoch;
    const price = usablePrice(prices, m);
    if (e === null || price === null || !quoting(s, pricing, e)) continue;
    const left = new Map(m.buckets.map((b) => [b.series, seriesLeft(m, b)]));
    const registering = new Set<bigint>();
    for (const o of s.idle) {
      if (o.asset !== m.market.token || o.frozen || !tradesSide(m, o.side)) continue;
      const b = m.buckets.find((x) => x.side === o.side && x.strike === o.target);
      if (b === undefined) continue;
      const premium = premiumFor(s, m, pricing, price, o.side, o.target);
      if (premium === null || premium < o.minPremium) continue;
      const series = left.get(b.series) ?? 0n;
      const amount = quoteSize(s, m, e, b, room, premium, o.size, series);
      if (amount === 0n) continue;
      if (!b.registered) {
        if (!registering.has(b.series)) {
          registering.add(b.series);
          actions.push({
            kind: "register",
            asset: m.market.token,
            side: b.side,
            strike: b.strike,
            expiry: e.expiry,
          });
        }
        continue;
      }
      left.set(b.series, series - amount);
      spend(room, m.market.token, o.side, o.target, premium, amount, s.feeBps, e);
      actions.push({
        kind: "fill",
        orderId: o.id,
        quote: {
          series: b.series,
          premium,
          maxFeeBps: s.feeBps,
          maxAmount: amount,
          minFill: amount,
          deadline: Math.min(s.now + QUOTE_LIFETIME, e.expiry),
        },
      });
    }
  }
  return actions;
}

// Registering, bidding and quoting take on risk at a price, so they wait for a price the guard
// passed, market by market. Approving, exercising and withdrawing don't: an exercise fills a
// holder's order at exactly its price, so a wrong one only costs the maker.
export function plan(s: MakerSnapshot, pricing: PricingConfig, prices: Prices): MakerAction[] {
  const room = freeRoom(s);
  return [
    ...housekeeping(s),
    ...exercises(s),
    ...bids(s, pricing, prices, room),
    ...quotes(s, pricing, prices, room),
  ];
}
