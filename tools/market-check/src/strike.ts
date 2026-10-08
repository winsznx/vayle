// A strike step proposal: a percentage of the feed's price, rounded in log terms to the nearest
// value of the 1, 2, 5 series (..., 0.5, 1, 2, 5, 10, 20, ...), in USDG base units. Integer math
// throughout. The nearest series value in log terms changes at the geometric midpoints sqrt(2),
// sqrt(10) and sqrt(50) of each decade, and a rational mantissa never lands exactly on one.

// Null when the price isn't positive or the step is smaller than one USDG base unit.
export function strikeStep(
  answer: bigint,
  feedDecimals: number,
  usdgDecimals: number,
  percent: number,
): bigint | null {
  if (!Number.isInteger(percent) || percent <= 0) {
    throw new RangeError(`the step's percentage must be a whole number, not ${percent}`);
  }
  // The target in USDG base units is num / den.
  const num = answer * BigInt(percent) * 10n ** BigInt(usdgDecimals);
  const den = 100n * 10n ** BigInt(feedDecimals);
  if (num <= 0n) return null;
  // The decade: 10^exponent <= num / den < 10^(exponent + 1).
  let exponent = 0;
  if (num >= den) {
    while (num >= den * 10n ** BigInt(exponent + 1)) exponent++;
  } else {
    exponent = -1;
    while (num * 10n ** BigInt(-exponent) < den) exponent--;
  }
  // The mantissa, in [1, 10), as m = mNum / mDen.
  const mNum = exponent >= 0 ? num : num * 10n ** BigInt(-exponent);
  const mDen = exponent >= 0 ? den * 10n ** BigInt(exponent) : den;
  const below = (square: bigint): boolean => mNum * mNum < square * mDen * mDen;
  const lead = below(2n) ? 1n : below(10n) ? 2n : below(50n) ? 5n : 10n;
  if (exponent >= 0) return lead * 10n ** BigInt(exponent);
  // Below one base unit, only 10 x 10^-1 is still a whole unit.
  return lead === 10n && exponent === -1 ? 1n : null;
}
