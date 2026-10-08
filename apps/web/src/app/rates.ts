import { phase, type Epoch, type Rung } from "./week.ts";

// What a target is paid for a week, as the rate sheet shows it. Two sources: the batch's best bids,
// which the chain records for this week's series during the bid window, and the maker's bid sheet,
// its current bid per target for fills by quote. Premiums are USDG base units per whole token.

export type RateSource = "batch" | "maker";

export interface Rate {
  readonly premium: bigint;
  readonly source: RateSource;
}

// One market's week on the maker's bid sheet: its current bid per target, per side.
export interface MakerBids {
  // When the maker computed the sheet, in seconds.
  readonly computedAt: number;
  readonly sell: ReadonlyMap<bigint, bigint>;
  readonly buy: ReadonlyMap<bigint, bigint>;
}

export interface RateInputs {
  readonly epoch: Epoch;
  // Chain time.
  readonly now: number;
  // This week's batch best bids from the chain, by strike.
  readonly batch: ReadonlyMap<bigint, bigint>;
  // Whether the build reads the maker's bid sheet at all.
  readonly readsSheet: boolean;
  // The sheet's bids for this market's week, or null when there's no sheet to use.
  readonly maker: MakerBids | null;
}

// Batch bids are the rates all week in a build without a bid sheet. With one, they show while the
// bid window runs, when the batch is what a target is paid, and the maker's current bids show the
// rest of the week.
export function batchBidsShow(inputs: RateInputs): boolean {
  return !inputs.readsSheet || phase(inputs.epoch, inputs.now) === "bidding";
}

export function rateOf(rung: Rung, inputs: RateInputs): Rate | null {
  if (batchBidsShow(inputs)) {
    const batch = inputs.batch.get(rung.strike);
    if (batch !== undefined) return { premium: batch, source: "batch" };
  }
  const maker = inputs.maker?.[rung.side].get(rung.strike);
  return maker === undefined ? null : { premium: maker, source: "maker" };
}

export interface SheetRow {
  readonly rung: Rung;
  readonly rate: Rate | null;
}

// The rungs a rate sheet shows, highest first: every sell target, and a buy target only where
// there's a bid for it, since a buy target nobody bids on can't be paid.
export function sheetRows(rungs: readonly Rung[], inputs: RateInputs): SheetRow[] {
  return rungs.flatMap((rung) => {
    const rate = rateOf(rung, inputs);
    return rung.side === "buy" && rate === null ? [] : [{ rung, rate }];
  });
}
