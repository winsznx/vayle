// This week's grid and where the week is, from the epoch the market recorded at its opening.

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
  // Above the close the holder sets a sell target (a call), below it a buy target (a put).
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

// The week's listed strikes, from the reference the market recorded.
export function ladder(e: Epoch): Rung[] {
  return ladderAround(e.referencePrice, e.strikeTick, e.strikeRangeBps);
}

// Whether the week has a renewal batch. The market records a week without one, the first week a
// market opens after its deploy, with its batch deadline at its opening: bids and batches are
// refused all week, nothing freezes, and targets fill only by quote from the opening to the close.
export function hasBatch(e: Epoch): boolean {
  return e.batchDeadline > e.opening;
}

// What the week's reference price was taken at: the close that opened it, or, in a week without a
// batch, the moment it opened.
export function referenceLabel(e: Epoch): "Close" | "Opening" {
  return hasBatch(e) ? "Close" : "Opening";
}

export function bidOpensAt(e: Epoch): number {
  return e.opening + e.windowLength;
}

// The earliest a batch can start: once every maker has had the whole bid window.
export function batchOpensAt(e: Epoch): number {
  return bidOpensAt(e) + BID_WINDOW;
}

export type Phase = "settling" | "bidding" | "live" | "expired";

// Where the week is for a holder deciding what to do. A week without a batch is live from its
// opening: there's no earlier week settling and no bid window.
export function phase(e: Epoch, now: number): Phase {
  if (now >= e.expiry) return "expired";
  if (!hasBatch(e)) return "live";
  if (now < bidOpensAt(e)) return "settling";
  if (now < e.batchDeadline) return "bidding";
  return "live";
}

// The moments a timeline of the week marks, in order. A week with a batch runs from the close that
// opened it through the bid window, the batch and the rest of the week to the next close. A week
// without one is a single stretch of fills by quote from its opening to the close, then the
// exercise window.
export type StageKey =
  "close" | "bids" | "batch" | "week" | "next-close" | "quotes" | "window" | "window-end";

export interface Stage {
  readonly key: StageKey;
  readonly at: number;
}

export function stagesOf(e: Epoch): Stage[] {
  if (!hasBatch(e)) {
    return [
      { key: "quotes", at: e.opening },
      { key: "window", at: e.expiry },
      { key: "window-end", at: e.expiry + e.windowLength },
    ];
  }
  const bidOpen = bidOpensAt(e);
  return [
    { key: "close", at: e.opening },
    { key: "bids", at: bidOpen },
    { key: "batch", at: bidOpen + BID_WINDOW },
    { key: "week", at: e.batchDeadline },
    { key: "next-close", at: e.expiry },
  ];
}

// The stage the clock is in, and how far along the whole track it is, from 0 at the first stage to
// 1 at the last. Stages are drawn evenly, so progress runs evenly within the current one.
export function progressOf(
  stages: readonly Stage[],
  now: number,
): { readonly index: number; readonly fill: number } {
  let index = 0;
  stages.forEach((s, i) => {
    if (now >= s.at) index = i;
  });
  const from = stages[index];
  const to = stages[index + 1];
  if (from === undefined || to === undefined || stages.length < 2) return { index, fill: 1 };
  const within = Math.min(1, Math.max(0, (now - from.at) / (to.at - from.at)));
  return { index, fill: (index + within) / (stages.length - 1) };
}
