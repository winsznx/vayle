// Liquidity math: what a dollar cap is in raw token units at the feed's price, what an amount is
// worth at that price in USDG base units (taking a dollar as one USDG), how far a quote falls short
// of that value in basis points, and the search for the largest size a route can sell within the
// limit. All integer math.

const BPS = 10_000n;

export interface PriceUnits {
  readonly answer: bigint;
  readonly feedDecimals: number;
  readonly tokenDecimals: number;
  readonly usdgDecimals: number;
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

// Raw token units worth `usdgAmount` USDG base units at the feed's price, rounded down.
export function sizeForValue(usdgAmount: bigint, p: PriceUnits): bigint {
  if (p.answer <= 0n) throw new RangeError("the feed's price isn't positive");
  return (
    (usdgAmount * pow10(p.tokenDecimals) * pow10(p.feedDecimals)) /
    (p.answer * pow10(p.usdgDecimals))
  );
}

// USDG base units that `amount` raw token units are worth at the feed's price, rounded down.
export function valueAtFeed(amount: bigint, p: PriceUnits): bigint {
  return (
    (amount * p.answer * pow10(p.usdgDecimals)) / (pow10(p.tokenDecimals) * pow10(p.feedDecimals))
  );
}

// Whether `out` is within `maxBps` of `value`, fees and price impact included.
export function withinLimit(out: bigint, value: bigint, maxBps: number): boolean {
  return out * BPS >= value * (BPS - BigInt(maxBps));
}

// How far `out` falls short of `value` in basis points, rounded up to hundredths. Negative when
// the route pays more than the feed's price.
export function shortfallBps(out: bigint, value: bigint): number {
  if (value <= 0n) throw new RangeError("there's no value to compare a quote with");
  const scaled = (value - out) * BPS * 100n;
  const hundredths = scaled >= 0n ? (scaled + value - 1n) / value : -(-scaled / value);
  return Number(hundredths) / 100;
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("no square root of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// The search for the largest size within the limit: geometric bisection over a bracket that
// spans SEARCH_SPAN either way of the cap, at most MAX_QUOTES quotes, assuming a bigger sale never
// does better against the feed's price than a smaller one through the same pools. When the cap
// fails, the first quote tries the bracket's floor, and if that fails too there's nothing to bisect.
export const SEARCH_SPAN = 1024n;
export const MAX_QUOTES = 8;

export interface Search {
  // The largest size quoted within the limit, the cap included when it passed.
  readonly within: bigint | null;
  readonly lower: bigint;
  readonly upper: bigint;
  readonly floorProbe: boolean;
  readonly quotes: number;
  readonly done: boolean;
}

export function startSearch(cap: bigint, capWithin: boolean): Search {
  if (cap <= 0n) throw new RangeError("the cap has no size");
  if (capWithin) {
    return {
      within: cap,
      lower: cap,
      upper: cap * SEARCH_SPAN,
      floorProbe: false,
      quotes: 0,
      done: false,
    };
  }
  const floor = cap / SEARCH_SPAN > 0n ? cap / SEARCH_SPAN : 1n;
  return { within: null, lower: floor, upper: cap, floorProbe: true, quotes: 0, done: false };
}

// The next size to quote, or null when the search is over.
export function nextSize(search: Search): bigint | null {
  if (search.done || search.quotes >= MAX_QUOTES) return null;
  if (search.floorProbe) return search.lower;
  const mid = isqrt(search.lower * search.upper);
  return mid > search.lower && mid < search.upper ? mid : null;
}

export function recordQuote(search: Search, size: bigint, within: boolean): Search {
  const quotes = search.quotes + 1;
  if (search.floorProbe) {
    return within
      ? { ...search, within: size, floorProbe: false, quotes }
      : { ...search, floorProbe: false, quotes, done: true };
  }
  if (within) {
    const best = search.within === null || size > search.within ? size : search.within;
    return { ...search, within: best, lower: size, quotes };
  }
  return { ...search, upper: size, quotes };
}
