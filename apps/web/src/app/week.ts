// This week's grid and where the week is, from the epoch the market recorded at the last close.

export interface Epoch {
  readonly opening: number;
  readonly expiry: number;
  readonly batchDeadline: number;
  readonly windowLength: number;
  // USDG base units per raw token.
  readonly referencePrice: bigint;
  readonly strikeTick: bigint;
  readonly strikeRangeBps: number;
  readonly priceTick: bigint;
  readonly lot: bigint;
  readonly rawUnit: bigint;
}

export type Side = "sell" | "buy";

export interface Rung {
  readonly strike: bigint;
  // Above the close the holder sells (a call), below it they buy (a put).
  readonly side: Side;
}

const BPS = 10_000n;
// The bid window opens when last week's exercise window has run, and lasts this long.
export const BID_WINDOW = 2 * 3600;

// The strikes around a reference price, highest first. Same rule as the market: out of the money,
// on the tick, within the band around the reference.
export function ladderAround(
  referencePrice: bigint,
  strikeTick: bigint,
  strikeRangeBps: number,
): Rung[] {
  const width = (referencePrice * BigInt(strikeRangeBps)) / BPS;
  const rungs: Rung[] = [];
  const top = ((referencePrice + width) / strikeTick) * strikeTick;
  for (let strike = top; strike > 0n && strike + width >= referencePrice; strike -= strikeTick) {
    if (strike > referencePrice) rungs.push({ strike, side: "sell" });
    else if (strike < referencePrice) rungs.push({ strike, side: "buy" });
  }
  return rungs;
}

// The week's listed strikes, from the close the market recorded.
export function ladder(e: Epoch): Rung[] {
  return ladderAround(e.referencePrice, e.strikeTick, e.strikeRangeBps);
}

export type Phase = "settling" | "bidding" | "live" | "expired";

// Where the week is for a holder deciding what to do.
export function phase(e: Epoch, now: number): Phase {
  if (now >= e.expiry) return "expired";
  const bidOpen = e.opening + e.windowLength;
  if (now < bidOpen) return "settling";
  if (now < e.batchDeadline) return "bidding";
  return "live";
}

export function bidOpensAt(e: Epoch): number {
  return e.opening + e.windowLength;
}
