// Close-to-close realized volatility: the sample standard deviation of log returns between
// consecutive session closes, annualized over 252 sessions a year, in basis points rounded to the
// nearest whole one.

const SESSIONS_PER_YEAR = 252;
const BPS = 10_000;

export class TooFewCloses extends Error {
  override readonly name = "TooFewCloses";
}

// `closes` are prices at consecutive session closes, oldest first, all in the same decimals.
export function realizedVolBps(closes: readonly bigint[]): number {
  if (closes.length < 3) {
    throw new TooFewCloses(`${closes.length} closes give fewer than 2 returns`);
  }
  if (closes.some((price) => price <= 0n)) throw new RangeError("a close price isn't positive");
  const returns: number[] = [];
  let previous: bigint | null = null;
  for (const price of closes) {
    if (previous !== null) returns.push(Math.log(Number(price) / Number(previous)));
    previous = price;
  }
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.round(Math.sqrt(variance) * Math.sqrt(SESSIONS_PER_YEAR) * BPS);
}
