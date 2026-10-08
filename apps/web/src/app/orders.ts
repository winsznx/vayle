import { nextStep, type NextStep, type OrderState, type SeriesState } from "@vayle/market";
import { amountOf, dollars, easternTime, type TokenUnit } from "./format.ts";
import { batchOpensAt, hasBatch, ladder, type Epoch } from "./week.ts";

// How a target reads on its row: what it is, what's happening to it, and what the holder can do.
// A sell target is the market's order on the call side, a buy target its order on the put side.

export type Tone = "brand" | "earned" | "plain";

// A short state for tables and lists, beside the full sentence in `status`.
export interface Chip {
  readonly label: string;
  readonly tone: Tone;
}

export type Kind = "Sell target" | "Buy target";

export interface OrderLine {
  readonly side: "sell" | "buy";
  readonly kind: Kind;
  // How much it's for, with the token's ticker, or null once nothing is left of it or when the
  // build doesn't list the target's market.
  readonly amount: string | null;
  readonly price: string;
  readonly status: string;
  readonly chip: Chip;
  readonly action: NextStep;
}

// The target in a sentence: its kind, then how much it's for.
export function nameOf(line: OrderLine): string {
  return line.amount === null ? line.kind : `${line.kind} for ${line.amount}`;
}

function chipFor(
  order: OrderState,
  series: SeriesState | null,
  epoch: Epoch | null,
  now: number,
  action: NextStep,
): Chip {
  if (order.series !== 0n && series !== null) {
    if (action === "settle" || action === "finalize-then-settle") {
      return { label: "Ready to settle", tone: "earned" };
    }
    return BigInt(now) < series.expiry
      ? { label: "This week", tone: "brand" }
      : { label: "Settling", tone: "plain" };
  }
  if (order.status === "cancelled") return { label: "Cancelled", tone: "plain" };
  if (order.status !== "active") return { label: "Closed", tone: "plain" };
  if (order.frozen) return { label: "In the batch", tone: "brand" };
  if (epoch !== null && !listedThisWeek(order, epoch)) return { label: "Skipping", tone: "plain" };
  return { label: "Waiting", tone: "plain" };
}

function listedThisWeek(order: OrderState, epoch: Epoch): boolean {
  return ladder(epoch).some(
    (r) => r.strike === order.target && (r.side === "sell") === (order.side === 0),
  );
}

function idleStatus(order: OrderState, epoch: Epoch | null, now: number): string {
  if (order.frozen)
    return "In this week's batch. You can change or cancel it once the batch finishes.";
  if (epoch === null) return "Waiting for the first week to open at the next weekly close.";
  if (!listedThisWeek(order, epoch)) {
    const passed =
      order.side === 0
        ? order.target <= epoch.referencePrice
        : order.target >= epoch.referencePrice;
    return passed
      ? "Skipping this week: the market passed your price."
      : "Skipping this week: your price is outside this week's range.";
  }
  if (now >= epoch.expiry) return "Waiting for the next week to open.";
  // A week without a batch fills only by quote, all the way to the close.
  if (!hasBatch(epoch)) {
    return `Waiting. It fills if the maker quotes it before the close on ${easternTime(epoch.expiry)}.`;
  }
  const batchOpens = batchOpensAt(epoch);
  if (now < batchOpens) return `Joins this week's batch, which starts ${easternTime(batchOpens)}.`;
  return "Waiting. It fills if the maker quotes it this week, or joins next week's batch.";
}

// A target in this week's trade, said with the signed-off risk lines filled in with its own stock,
// price and close.
function writtenStatus(
  order: OrderState,
  series: SeriesState,
  now: number,
  unit: TokenUnit | null,
  heldUntil: bigint | null,
): string {
  if (series.settled) return "This week's result is in. Settle to collect it.";
  if (heldUntil !== null && BigInt(now) >= series.windowEnd) {
    return `The week ended, and its result is final from ${easternTime(Number(heldUntil))} at the earliest. The chain has been quiet, and quiet time keeps the window open longer.`;
  }
  if (BigInt(now) < series.expiry) {
    const amount = unit === null ? null : amountOf(order.committed, unit);
    // Only part of the target in this week's trade is named by its amount.
    const part = order.committed === order.size ? null : amount;
    const stock = unit?.symbol ?? "the stock";
    const ends = easternTime(Number(series.expiry));
    const outcome =
      order.side === 0
        ? `If ${stock} closes above ${dollars(order.target)} on ${ends}, ${part === null ? "your tokens sell" : `${part} sells`} at exactly your price.`
        : `If ${stock} closes below ${dollars(order.target)} on ${ends}, you buy ${amount === null ? "" : `${amount} `}at that price, even if the close is lower.`;
    return order.status === "active" ? outcome : `${outcome} It won't renew after this week.`;
  }
  if (BigInt(now) < series.windowEnd) {
    return `The week ended. The result is final at ${easternTime(Number(series.windowEnd))}.`;
  }
  return "The week is over. Settle to collect the result.";
}

// `unit` is how the target's token prints, null when the build doesn't list its market. `heldUntil`
// is the end finalize reports for the target's series when the view says its window is over but
// finalize would still find it open.
export function describeOrder(
  order: OrderState,
  series: SeriesState | null,
  epoch: Epoch | null,
  now: number,
  unit: TokenUnit | null,
  heldUntil: bigint | null = null,
): OrderLine {
  const side = order.side === 0 ? "sell" : "buy";
  const kind = side === "sell" ? "Sell target" : "Buy target";
  const amount = order.size === 0n || unit === null ? null : amountOf(order.size, unit);
  const step = nextStep(order, series, BigInt(now));
  const action = step === "finalize-then-settle" && heldUntil !== null ? "wait" : step;
  let status: string;
  if (order.series !== 0n && series !== null) {
    status = writtenStatus(order, series, now, unit, heldUntil);
  } else if (order.status === "active") status = idleStatus(order, epoch, now);
  else status = order.status === "cancelled" ? "Cancelled." : "Closed.";
  const chip = chipFor(order, series, epoch, now, action);
  return { side, kind, amount, price: dollars(order.target), status, chip, action };
}
