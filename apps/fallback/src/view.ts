import {
  nextStep,
  type Call,
  type NextStep,
  type OrderState,
  type SeriesState,
} from "@vayle/market";
import { formatFixed, isWholeLots, parseFixed, valueExact } from "@vayle/units";

// What the page shows, as plain text from chain values. Amounts are exact: nothing is rounded.

export interface Units {
  readonly assetSymbol: string;
  readonly assetDecimals: number;
  readonly usdgDecimals: number;
}

export function amount(units: bigint, decimals: number, symbol: string): string {
  return `${formatFixed(units, decimals)} ${symbol}`;
}

const EASTERN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

// A chain timestamp in New York time, where the market's weeks are set, and in UTC.
export function moment(seconds: bigint): string {
  const date = new Date(Number(seconds) * 1000);
  const utc = date.toISOString().slice(0, 16).replace("T", " ");
  return `${EASTERN.format(date)} (${utc} UTC)`;
}

// A length of time the market defines, in words, so copy never restates one of its numbers.
export function duration(seconds: bigint): string {
  const parts = [
    [seconds / 3600n, "hour"],
    [(seconds % 3600n) / 60n, "minute"],
    [seconds % 60n, "second"],
  ] as const;
  const words = parts
    .filter(([count]) => count > 0n)
    .map(([count, unit]) => `${count} ${unit}${count === 1n ? "" : "s"}`);
  return words.length === 0 ? "0 seconds" : words.join(" ");
}

export interface OrderLine {
  readonly what: string;
  readonly state: string;
  readonly step: NextStep;
}

function attachedState(order: OrderState, series: SeriesState, now: bigint, units: Units): string {
  const part = amount(order.committed, units.assetDecimals, units.assetSymbol);
  const window =
    now < series.windowEnd
      ? `Its exercise window ends ${moment(series.windowEnd)}.`
      : `Its exercise window ended ${moment(series.windowEnd)}.`;
  const finalized = series.settled ? "The series is finalized." : "The series isn't finalized yet.";
  const renewal =
    order.status === "active"
      ? "It renews after it settles unless you stop it."
      : "It won't renew after it settles.";
  return `${part} is in series ${series.id}, which expires ${moment(series.expiry)}. ${window} ${finalized} ${renewal}`;
}

// A window the market's view says is over, but that finalize would still find open: the
// simulation reverted WindowStillOpen. Usually quiet time nobody has recorded yet, since finalize
// records it first.
export interface HeldOpen {
  // The end finalize reported, which keeps moving while the chain stays quiet.
  readonly until: bigint;
  // The chain's last checkpoint, when that's longer ago than the gap threshold.
  readonly quietSince: bigint | null;
  // The latest the window can close: its end now plus the whole extension allowance. An issuer
  // pause or a halt can still add to it.
  readonly latest: bigint;
}

function heldOpenState(
  order: OrderState,
  series: SeriesState,
  held: HeldOpen,
  units: Units,
): string {
  const part = amount(order.committed, units.assetDecimals, units.assetSymbol);
  const opening = `${part} is in series ${series.id}, which expired ${moment(series.expiry)}. Its exercise window is still open, until at least ${moment(held.until)}.`;
  if (held.quietSince === null) return opening;
  return `${opening} Nobody has checkpointed the chain since ${moment(held.quietSince)}, and quiet time keeps a window open, up to a day in total. It closes by ${moment(held.latest)} at the latest.`;
}

export function orderLine(
  order: OrderState,
  series: SeriesState | null,
  now: bigint,
  units: Units,
  held: HeldOpen | null = null,
): OrderLine {
  const verb = order.side === 0 ? "Sell" : "Buy";
  // A closed order has nothing left in it, so it's named without an amount.
  const size =
    order.size === 0n
      ? units.assetSymbol
      : amount(order.size, units.assetDecimals, units.assetSymbol);
  const what = `${verb} ${size} at ${amount(order.target, units.usdgDecimals, "USDG")} per token`;
  const step = nextStep(order, series, now);
  if (step === "finalize-then-settle" && series !== null && held !== null) {
    return { what, state: heldOpenState(order, series, held, units), step: "wait" };
  }
  let state: string;
  if (order.series !== 0n && series !== null) state = attachedState(order, series, now, units);
  else if (order.status === "active") {
    state = order.frozen
      ? "Active, and part of a renewal batch that hasn't finished. It can't be cancelled until the batch is done."
      : "Active, waiting for a week to fill it.";
  } else state = order.status === "cancelled" ? "Cancelled." : "Closed.";
  return { what, state, step };
}

// Everything a wallet or a block explorer needs to send the same transactions by hand.
export function calldata(calls: readonly Call[]): string {
  return calls
    .map((c, i) => `${calls.length > 1 ? `${i + 1}. ` : ""}to: ${c.to}\ndata: ${c.data}`)
    .join("\n\n");
}

// A long position as the market reports it, for exercising.
export interface Position {
  readonly series: SeriesState;
  readonly balance: bigint;
  readonly lot: bigint;
  readonly rawUnit: bigint;
}

export type ExerciseCheck =
  | {
      readonly ok: true;
      readonly amount: bigint;
      // The strike's value of `amount`, in USDG base units.
      readonly strikeValue: bigint;
      readonly pays: { readonly token: "asset" | "usdg"; readonly amount: bigint };
    }
  | { readonly ok: false; readonly problem: string };

// The market's own rules for an exercise, checked before anything is sent: open window, whole lots,
// no more than held. A call pays the strike in USDG for the asset, a put delivers the asset for
// USDG.
export function checkExercise(
  p: Position,
  typed: string,
  now: bigint,
  units: Units,
): ExerciseCheck {
  if (now < p.series.expiry) {
    return { ok: false, problem: `The exercise window opens ${moment(p.series.expiry)}.` };
  }
  if (now >= p.series.windowEnd || p.series.settled) {
    return { ok: false, problem: "The exercise window has closed." };
  }
  const size = parseFixed(typed, units.assetDecimals);
  if (size === null || size === 0n) {
    return { ok: false, problem: `Enter an amount of ${units.assetSymbol}, like 0.5.` };
  }
  if (!isWholeLots(size, p.lot)) {
    return {
      ok: false,
      problem: `Amounts go in steps of ${amount(p.lot, units.assetDecimals, units.assetSymbol)}.`,
    };
  }
  if (size > p.balance) {
    return { ok: false, problem: "That's more than this account holds in the series." };
  }
  const strikeValue = valueExact(size, p.series.strike, p.rawUnit);
  const pays =
    p.series.side === 0
      ? { token: "usdg" as const, amount: strikeValue }
      : { token: "asset" as const, amount: size };
  return { ok: true, amount: size, strikeValue, pays };
}
