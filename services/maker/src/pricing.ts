// Black-Scholes for the weekly options the maker buys, on the raw token, in floating point. Only
// the final bid becomes an integer, floored to the price tick, so the maker never bids above its
// own price.

export type Side = "call" | "put";

export interface PricingInput {
  readonly side: Side;
  // Spot and strike in the same unit, for example USDG per raw token.
  readonly spot: number;
  readonly strike: number;
  readonly years: number;
  readonly vol: number;
  readonly rate: number;
  readonly dividendYield: number;
}

// The issuer withholds 30% of every dividend equivalent and the token's multiplier reinvests the
// rest, so the raw token loses 30% of each gross dividend on the ex-date.
export const WITHHELD_SHARE = 0.3;
export const SECONDS_PER_YEAR = 365 * 86_400;

export function effectiveDividendYield(grossYield: number): number {
  return grossYield * WITHHELD_SHARE;
}

// Abramowitz and Stegun 7.1.26, absolute error under 1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-z * z));
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function blackScholes(input: PricingInput): number {
  const { side, spot, strike, years, vol, rate, dividendYield } = input;
  const carry = Math.exp(-dividendYield * years);
  const discount = Math.exp(-rate * years);
  if (years <= 0 || vol <= 0) {
    const intrinsic = side === "call" ? spot - strike : strike - spot;
    return Math.max(intrinsic, 0);
  }
  const spread = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (rate - dividendYield + (vol * vol) / 2) * years) / spread;
  const d2 = d1 - spread;
  if (side === "call") return spot * carry * normalCdf(d1) - strike * discount * normalCdf(d2);
  return strike * discount * normalCdf(-d2) - spot * carry * normalCdf(-d1);
}

// The maker's bid in USDG base units per raw token: fair value less the edge, floored to the tick.
// Null when that's under one tick, so the maker doesn't bid.
export function bidPremium(
  fairUsdg: number,
  edgeBps: number,
  usdgDecimals: number,
  tick: bigint,
): bigint | null {
  const bid = fairUsdg * (1 - edgeBps / 10_000) * 10 ** usdgDecimals;
  if (!Number.isFinite(bid) || bid < Number(tick)) return null;
  const units = BigInt(Math.floor(bid));
  return units - (units % tick);
}
