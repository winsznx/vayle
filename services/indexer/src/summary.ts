// What the app shows on an order card, worked out from the order's stored events.

export interface StoredEvent {
  readonly block_number: number;
  readonly log_index: number;
  readonly tx_hash: string;
  readonly block_time: string;
  readonly name: string;
  readonly order_id: string | null;
  readonly series: string | null;
  readonly account: string | null;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface Week {
  readonly opening: number;
  readonly expiry: number;
}

export type OrderState = "active" | "cancelled" | "closed";

export interface OrderSummary {
  readonly id: string;
  readonly state: OrderState;
  // USDG base units, as a decimal string.
  readonly premiumEarned: string;
  readonly weeksFilled: number;
  readonly skipStreak: number;
}

// A week counts once its batch deadline has passed, which is under 3 days after its opening.
export const WEEK_SETTLES_AFTER = 3 * 86_400;
// An order placed before the batch opens, 4 hours after the opening, can join that week's batch.
export const BATCH_OPENS_AFTER = 4 * 3600;

function seconds(isoTime: string): number {
  return Math.floor(Date.parse(isoTime) / 1000);
}

function text(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" ? value : null;
}

export function weeksOf(epochEvents: readonly StoredEvent[]): Week[] {
  return epochEvents
    .filter((e) => e.name === "EpochCreated")
    .map((e) => ({
      opening: Number(text(e.args, "opening") ?? Number.NaN),
      expiry: Number(text(e.args, "expiry") ?? Number.NaN),
    }))
    .filter((w) => Number.isFinite(w.opening) && Number.isFinite(w.expiry));
}

export function seriesExpiries(seriesEvents: readonly StoredEvent[]): Map<string, number> {
  const expiries = new Map<string, number>();
  for (const e of seriesEvents) {
    const key = e.args["key"];
    if (e.name !== "SeriesRegistered" || e.series === null) continue;
    if (typeof key !== "object" || key === null || !("expiry" in key)) continue;
    expiries.set(e.series, Number(key.expiry));
  }
  return expiries;
}

export function orderSummary(
  id: string,
  orderEvents: readonly StoredEvent[],
  weeks: readonly Week[],
  expiries: ReadonlyMap<string, number>,
  now: number,
): OrderSummary {
  const own = orderEvents.filter((e) => e.order_id === id);
  const state: OrderState = own.some((e) => e.name === "OrderClosed")
    ? "closed"
    : own.some((e) => e.name === "OrderCancelled")
      ? "cancelled"
      : "active";
  const fills = own.filter((e) => e.name === "QuoteFilled" || e.name === "BatchFilled");
  const premiumEarned = fills.reduce(
    (sum, e) => sum + BigInt(text(e.args, "premiumValue") ?? "0"),
    0n,
  );
  const filledExpiries = new Set(
    fills.flatMap((e) => {
      const expiry = e.series === null ? undefined : expiries.get(e.series);
      return expiry === undefined ? [] : [expiry];
    }),
  );
  const placed = own.find((e) => e.name === "OrderPlaced");
  const placedAt = placed === undefined ? Number.POSITIVE_INFINITY : seconds(placed.block_time);
  const counted = weeks
    .filter((w) => w.opening + WEEK_SETTLES_AFTER <= now)
    .filter((w) => filledExpiries.has(w.expiry) || placedAt < w.opening + BATCH_OPENS_AFTER)
    .sort((a, b) => b.opening - a.opening);
  let skipStreak = 0;
  if (state === "active") {
    for (const w of counted) {
      if (filledExpiries.has(w.expiry)) break;
      skipStreak++;
    }
  }
  return {
    id,
    state,
    premiumEarned: premiumEarned.toString(),
    weeksFilled: filledExpiries.size,
    skipStreak,
  };
}
