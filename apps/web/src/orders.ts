import { nextStep, type NextStep, type OrderState, type SeriesState } from "@vayle/market";
import { dollars, easternTime, tokens } from "./format.ts";
import { BID_WINDOW, ladder, type Epoch } from "./week.ts";

// How an order reads on its row: what it is, what's happening to it, and what the holder can do.

export interface OrderLine {
  readonly side: "sell" | "buy";
  readonly title: string;
  readonly price: string;
  readonly status: string;
  readonly action: NextStep;
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
  const batchOpens = epoch.opening + epoch.windowLength + BID_WINDOW;
  if (now < batchOpens) return `Joins this week's batch, which starts ${easternTime(batchOpens)}.`;
  return "Waiting. It fills if the maker quotes it this week, or joins next week's batch.";
}

// An order in this week's trade, said as what happens to the holder rather than in option terms.
function writtenStatus(
  order: OrderState,
  series: SeriesState,
  now: number,
  symbol: string,
  heldUntil: bigint | null,
): string {
  if (series.settled) return "This week's result is in. Settle to collect it.";
  if (heldUntil !== null && BigInt(now) >= series.windowEnd) {
    return `The week ended, and its result is final from ${easternTime(Number(heldUntil))} at the earliest. The chain has been quiet, and quiet time keeps the window open longer.`;
  }
  if (BigInt(now) < series.expiry) {
    const part = order.committed === order.size ? "It" : `${tokens(order.committed, symbol)} of it`;
    const ends = easternTime(Number(series.expiry));
    return order.side === 0
      ? `${part} sells at ${dollars(order.target)} if ${symbol} is above that when the week ends on ${ends}.`
      : `${part} buys at ${dollars(order.target)} if ${symbol} is below that when the week ends on ${ends}.`;
  }
  if (BigInt(now) < series.windowEnd) {
    return `The week ended. The result is final at ${easternTime(Number(series.windowEnd))}.`;
  }
  return "The week is over. Settle to collect the result.";
}

// `heldUntil` is the end finalize reports for the order's series when the view says its window is
// over but finalize would still find it open.
export function describeOrder(
  order: OrderState,
  series: SeriesState | null,
  epoch: Epoch | null,
  now: number,
  symbol: string,
  heldUntil: bigint | null = null,
): OrderLine {
  const side = order.side === 0 ? "sell" : "buy";
  const verb = side === "sell" ? "Sell" : "Buy";
  const title = `${verb} ${tokens(order.size, symbol)} at`;
  const step = nextStep(order, series, BigInt(now));
  const action = step === "finalize-then-settle" && heldUntil !== null ? "wait" : step;
  let status: string;
  if (order.series !== 0n && series !== null) {
    status = writtenStatus(order, series, now, symbol, heldUntil);
  } else if (order.status === "active") status = idleStatus(order, epoch, now);
  else status = order.status === "cancelled" ? "Cancelled." : "Closed.";
  return { side, title, price: dollars(order.target), status, action };
}
