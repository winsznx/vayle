import type { Address } from "viem";

// What the keeper does, as a pure function of what it read. Every action is a permissionless
// contract call, and a repeated or stale one reverts without effect.

export type Action =
  | { readonly kind: "checkpoint" }
  | { readonly kind: "observeClose"; readonly asset: Address }
  | { readonly kind: "observePauses"; readonly asset: Address }
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
  readonly side: number;
  readonly target: bigint;
  readonly status: OrderStatus;
  readonly series: bigint;
  readonly minPremium: bigint;
}

export type BatchPhase = "none" | "counting" | "filling" | "done";

// A bucket of the current epoch: its series, the best bid on it and its batch.
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

export interface Snapshot {
  readonly now: number;
  readonly asset: Address;
  readonly lookback: number;
  readonly bidWindow: number;
  readonly latestBoundary: Boundary | null;
  readonly nextClose: number | null;
  readonly epoch: EpochView | null;
  // Whether the asset has an epoch opened at the latest boundary.
  readonly epochAtLatest: boolean;
  readonly roundHint: bigint | null;
  readonly series: readonly SeriesView[];
  // Null outside the days after a close, when the keeper doesn't read orders.
  readonly orders: readonly OrderView[] | null;
  readonly buckets: readonly BucketView[];
}

const MINUTE = 60;
// The keeper starts pinging this long before each close, so its first ping after a quiet stretch
// lands well before the liveness lookback.
export const KEEPER_LEAD = 45 * MINUTE;
// Pings run through the expiring week's window and its usual tail.
export const AFTER_CLOSE = 150 * MINUTE;
export const CHUNK = 100;

function pings(s: Snapshot): Action[] {
  const actions: Action[] = [];
  if (s.nextClose !== null && s.now >= s.nextClose - KEEPER_LEAD) {
    actions.push(
      s.now >= s.nextClose - s.lookback
        ? { kind: "observeClose", asset: s.asset }
        : { kind: "checkpoint" },
    );
  }
  const afterClose = s.latestBoundary !== null && s.now <= s.latestBoundary.close + AFTER_CLOSE;
  const windowOpen = s.series.some((w) => s.now >= w.expiry && s.now < w.windowEnd);
  if (afterClose || windowOpen) {
    actions.push({ kind: "checkpoint" }, { kind: "observePauses", asset: s.asset });
  }
  return actions;
}

function epochCreation(s: Snapshot): Action[] {
  const b = s.latestBoundary;
  if (b === null || s.epochAtLatest || s.roundHint === null) return [];
  if (s.now <= b.close || s.now >= b.creationDeadline) return [];
  return [{ kind: "createEpoch", asset: s.asset, roundHint: s.roundHint }];
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

function batches(s: Snapshot, orders: readonly OrderView[]): Action[] {
  const e = s.epoch;
  if (e === null) return [];
  const actions: Action[] = [];
  for (const bucket of s.buckets) {
    if (bucket.bidPremium === null) continue;
    const idle = orders.filter(
      (o) =>
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

export function plan(s: Snapshot): Action[] {
  const actions = [...pings(s), ...epochCreation(s), ...finalizations(s)];
  if (s.orders !== null) actions.push(...settlements(s, s.orders), ...batches(s, s.orders));
  return actions;
}
