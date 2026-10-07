// Raw-unit arithmetic, mirroring contracts/src/libraries/Units.sol. Amounts are token base units.
// Prices are USDG base units per one whole raw token (rawUnit = 10**decimals base units). Shares
// appear only in display, through the token's UI multiplier.

export const BPS = 10_000n;
export const MULTIPLIER_SCALE = 10n ** 18n;

export type Rounding = "floor" | "ceil";

export class InexactValue extends Error {
  override readonly name = "InexactValue";
}

function requireNonNegative(name: string, value: bigint): void {
  if (value < 0n) throw new RangeError(`${name} must not be negative, got ${value}`);
}

function requirePositive(name: string, value: bigint): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive, got ${value}`);
}

function divide(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const quotient = numerator / denominator;
  return rounding === "ceil" && quotient * denominator !== numerator ? quotient + 1n : quotient;
}

export function value(amount: bigint, price: bigint, rawUnit: bigint, rounding: Rounding): bigint {
  requireNonNegative("amount", amount);
  requireNonNegative("price", price);
  requirePositive("rawUnit", rawUnit);
  return divide(amount * price, rawUnit, rounding);
}

export function valueExact(amount: bigint, price: bigint, rawUnit: bigint): bigint {
  const floor = value(amount, price, rawUnit, "floor");
  if (floor * rawUnit !== amount * price) {
    throw new InexactValue(`${amount} * ${price} / ${rawUnit} isn't a whole number`);
  }
  return floor;
}

// Rounded up because the payer covers it.
export function fee(premium: bigint, feeBps: bigint): bigint {
  requireNonNegative("premium", premium);
  requireNonNegative("feeBps", feeBps);
  return divide(premium * feeBps, BPS, "ceil");
}

export function isWholeLots(amount: bigint, lot: bigint): boolean {
  requirePositive("lot", lot);
  return amount > 0n && amount % lot === 0n;
}

export function isOnTick(price: bigint, tick: bigint): boolean {
  requirePositive("tick", tick);
  return price >= 0n && price % tick === 0n;
}

export function gridIsExact(lot: bigint, priceTick: bigint, rawUnit: bigint): boolean {
  requirePositive("rawUnit", rawUnit);
  return lot > 0n && priceTick > 0n && (lot * priceTick) % rawUnit === 0n;
}

// Display only. One raw token is `multiplier / 1e18` shares.
export function toShares(raw: bigint, multiplier: bigint): bigint {
  requireNonNegative("raw", raw);
  requirePositive("multiplier", multiplier);
  return (raw * multiplier) / MULTIPLIER_SCALE;
}

// Display only. A price per raw token expressed per share, rounded down.
export function pricePerShare(pricePerRawToken: bigint, multiplier: bigint): bigint {
  requireNonNegative("pricePerRawToken", pricePerRawToken);
  requirePositive("multiplier", multiplier);
  return (pricePerRawToken * MULTIPLIER_SCALE) / multiplier;
}

// Fixed-point decimal string, for example formatFixed(239_430_000n, 6) === "239.43".
export function formatFixed(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a whole number, got ${decimals}`);
  }
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

const DECIMAL = /^\d+(\.\d+)?$/;

// The inverse of formatFixed for text a person typed: parseFixed("1.25", 6) === 1_250_000n. Null for
// anything that isn't a plain non-negative decimal, or that has more places than the unit holds,
// so nothing typed is ever rounded.
export function parseFixed(text: string, decimals: number): bigint | null {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`decimals must be a whole number, got ${decimals}`);
  }
  const trimmed = text.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}
