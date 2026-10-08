import type { Address } from "viem";

// What the keeper does, as a pure function of what it read. Every action is a permissionless
// contract call, and a repeated or stale one reverts without effect.

export type Action =
  | { readonly kind: "checkpoint" }
  | { readonly kind: "observeClose"; readonly asset: Address }
  | { readonly kind: "observePauses"; readonly asset: Address }
  | { readonly kind: "createFirstEpoch"; readonly asset: Address; readonly roundHint: bigint }
  | { readonly kind: "createEpoch"; readonly asset: Address; readonly roundHint: bigint }
  | { readonly kind: "finalize"; readonly series: bigint }
  | { readonly kind: "settleOrder"; readonly id: bigint }
  | { readonly kind: "openBatch"; readonly series: bigint }
  | { readonly kind: "countBatch"; readonly series: bigint; readonly ids: readonly bigint[] }
  | { readonly kind: "fillBatch"; readonly series: bigint; readonly ids: readonly bigint[] }
  | { readonly kind: "closeBatch"; readonly series: bigint };

export interface Boundary {
  readonly close: number;
  readonly creationDeadline: number;
}

export interface EpochView {
  readonly opening: number;
  readonly expiry: number;
  readonly batchDeadline: number;
  readonly windowLength: number;
}

// A series some order is still attached to.
export interface SeriesView {
  readonly id: bigint;
  readonly expiry: number;
  readonly windowEnd: number;
  readonly settled: boolean;
}

export type OrderStatus = "active" | "cancelled" | "closed";

export interface OrderView {
  readonly id: bigint;
  readonly asset: Address;
  readonly side: number;
  readonly target: bigint;
  readonly status: OrderStatus;
  readonly series: bigint;
  readonly minPremium: bigint;
}

export type BatchPhase = "none" | "counting" | "filling" | "done";

// A bucket of a market's current epoch: its series, the best bid on it and its batch.
export interface BucketView {
  readonly series: bigint;
  readonly side: number;
  readonly target: bigint;
  readonly bidPremium: bigint | null;
  readonly phase: BatchPhase;
  readonly cursor: bigint;
  readonly maxOrderId: bigint;
  readonly attached: bigint;
}

// One market from the markets file whose listing in the token registry matches the file.
export interface MarketView {
  readonly asset: Address;
  // The market's latest epoch, or null before its first.
  readonly epoch: EpochView | null;
  // Whether that epoch opened at the latest boundary.
  readonly epochAtLatest: boolean;
  // The feed's last round at or before the latest boundary's close, read only while an epoch is due.
  readonly roundHint: bigint | null;
  // The round createFirstEpoch takes, read only while the market waits for its first week and the
  // market is old enough to open it.
  readonly firstHint: bigint | null;
  readonly buckets: readonly BucketView[];
}

export interface Snapshot {
  readonly now: number;
  readonly lookback: number;
  readonly bidWindow: number;
  // When the market was deployed. Its liveness record covers a whole lookback from then on.
  readonly deployedAt: number;
  readonly latestBoundary: Boundary | null;
  readonly nextClose: number | null;
  readonly markets: readonly MarketView[];
  readonly series: readonly SeriesView[];
  // Null outside the days after a close, when the keeper doesn't read orders.
  readonly orders: readonly OrderView[] | null;
}

const MINUTE = 60;
// The keeper starts pinging this long before each close, so its first ping after a quiet stretch
// lands well before the liveness lookback.
export const KEEPER_LEAD = 45 * MINUTE;
// Pings run through the expiring week's window and its usual tail.
export const AFTER_CLOSE = 150 * MINUTE;
export const CHUNK = 100;

// The markets still waiting for their first week. Before the schedule's first close there's no close
// to open a week at, so each market's first week opens at the moment createFirstEpoch lands and runs
// to that close. No boundary at or before now, with a close ahead, means the first close is ahead.
function awaitingFirstWeek(s: Snapshot): readonly MarketView[] {
  const firstCloseAhead = s.latestBoundary === null && s.nextClose !== null;
  return firstCloseAhead ? s.markets.filter((m) => m.epoch === null) : [];
}

// A first week opens only on a liveness record with no gap through the lookback before its opening,
// so while any market waits for one the keeper checkpoints every run, well inside the 5-minute gap
// threshold.
function pings(s: Snapshot): Action[] {
  let checkpoint = awaitingFirstWeek(s).length > 0;
  const observations: Action[] = [];
  if (s.nextClose !== null && s.now >= s.nextClose - KEEPER_LEAD) {
    if (s.now >= s.nextClose - s.lookback && s.markets.length > 0) {
      // Each observation checkpoints too.
      observations.push(
        ...s.markets.map((m): Action => ({ kind: "observeClose", asset: m.asset })),
      );
    } else {
      checkpoint = true;
    }
  }
  const afterClose = s.latestBoundary !== null && s.now <= s.latestBoundary.close + AFTER_CLOSE;
  const windowOpen = s.series.some((w) => s.now >= w.expiry && s.now < w.windowEnd);
  if (afterClose || windowOpen) {
    checkpoint = true;
    observations.push(...s.markets.map((m): Action => ({ kind: "observePauses", asset: m.asset })));
  }
  return checkpoint ? [{ kind: "checkpoint" }, ...observations] : observations;
}

// Once the market's liveness record covers the lookback, each waiting market's first week opens.
function firstEpochs(s: Snapshot): Action[] {
  if (s.now < s.deployedAt + s.lookback) return [];
  return awaitingFirstWeek(s).flatMap((m): Action[] =>
    m.firstHint === null
      ? []
      : [{ kind: "createFirstEpoch", asset: m.asset, roundHint: m.firstHint }],
  );
}

function epochCreation(s: Snapshot): Action[] {
  const b = s.latestBoundary;
  if (b === null || s.now <= b.close || s.now >= b.creationDeadline) return [];
  return s.markets.flatMap((m): Action[] =>
    m.epochAtLatest || m.roundHint === null
      ? []
      : [{ kind: "createEpoch", asset: m.asset, roundHint: m.roundHint }],
  );
}

function finalizations(s: Snapshot): Action[] {
  return s.series
    .filter((w) => !w.settled && s.now >= w.windowEnd)
    .map((w) => ({ kind: "finalize", series: w.id }));
}

function settlements(s: Snapshot, orders: readonly OrderView[]): Action[] {
  const settled = new Set(s.series.filter((w) => w.settled).map((w) => w.id));
  return orders
    .filter((o) => o.series !== 0n && settled.has(o.series))
    .map((o) => ({ kind: "settleOrder", id: o.id }));
}

function nextIds(ids: readonly bigint[], after: bigint, upTo: bigint): bigint[] {
  return ids
    .filter((id) => id > after && id <= upTo)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    .slice(0, CHUNK);
}

function marketBatches(
  s: Snapshot,
  m: MarketView,
  e: EpochView,
  orders: readonly OrderView[],
): Action[] {
  const actions: Action[] = [];
  for (const bucket of m.buckets) {
    if (bucket.bidPremium === null) continue;
    const idle = orders.filter(
      (o) =>
        o.asset === m.asset &&
        o.status === "active" &&
        o.series === 0n &&
        o.side === bucket.side &&
        o.target === bucket.target,
    );
    if (bucket.phase === "none") {
      const open = s.now >= e.opening + e.windowLength + s.bidWindow && s.now < e.batchDeadline;
      if (open && bucket.attached === 0n && idle.length > 0) {
        actions.push({ kind: "openBatch", series: bucket.series });
      }
    } else if (bucket.phase === "counting" && s.now < e.batchDeadline) {
      const ids = nextIds(
        idle.map((o) => o.id),
        bucket.cursor,
        bucket.maxOrderId,
      );
      if (ids.length > 0) actions.push({ kind: "countBatch", series: bucket.series, ids });
    } else if (bucket.phase === "filling") {
      if (s.now >= e.expiry) {
        actions.push({ kind: "closeBatch", series: bucket.series });
        continue;
      }
      const premium = bucket.bidPremium;
      const eligible = idle.filter((o) => o.minPremium <= premium).map((o) => o.id);
      const ids = nextIds(eligible, bucket.cursor, bucket.maxOrderId);
      if (ids.length > 0) actions.push({ kind: "fillBatch", series: bucket.series, ids });
    }
  }
  return actions;
}

function batches(s: Snapshot, orders: readonly OrderView[]): Action[] {
  return s.markets.flatMap((m) => (m.epoch === null ? [] : marketBatches(s, m, m.epoch, orders)));
}

export function plan(s: Snapshot): Action[] {
  const actions = [...pings(s), ...firstEpochs(s), ...epochCreation(s), ...finalizations(s)];
  if (s.orders !== null) actions.push(...settlements(s, s.orders), ...batches(s, s.orders));
  return actions;
}
