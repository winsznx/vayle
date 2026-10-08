import type { Address } from "viem";
import { feed, type Round } from "./probes.ts";
import type { Handle, Rpc } from "./rpc.ts";

// Walks each feed's rounds back from its latest one with getRoundData through Multicall3, every
// feed's window in the same calls, until the walk holds a round published at or before the time
// it needs. A proxy's round ID is (phase << 64) | the aggregator's round, so a phase's rounds are
// consecutive and its first one is aggregator round 1.

const AGGREGATOR_ROUND_MASK = (1n << 64n) - 1n;
// getRoundData through a proxy costs about 8,700 gas, so a call of 2,000 is under 18M gas.
const READS_PER_CALL = 2_000;
const FIRST_WINDOW = 128;
const MIN_WINDOW = 32;
const MAX_WINDOW = 2_048;
const MAX_STEPS = 12;

export interface WalkTarget {
  readonly proxy: Address;
  readonly latest: Round;
  // The walk is done once it holds a round updated at or before this time.
  readonly until: number;
}

export interface Walk {
  // Every round read, oldest first.
  readonly rounds: readonly Round[];
  readonly roundsRead: number;
  // True when the walk reached `until` or the feed's first round ever. False with a reason when it
  // stopped short.
  readonly complete: boolean;
  readonly reason: string;
}

export function phaseOf(roundId: bigint): bigint {
  return roundId >> 64n;
}

export function aggregatorRound(roundId: bigint): bigint {
  return roundId & AGGREGATOR_ROUND_MASK;
}

// The next window's size: enough rounds to reach `until` at the rate the walk has seen so far,
// with a quarter more for an uneven rate.
export function nextWindow(newest: Round, oldest: Round, count: number, until: number): number {
  const span = newest.updatedAt - oldest.updatedAt;
  if (span <= 0 || count < 2) return MAX_WINDOW;
  const perRound = span / (count - 1);
  const needed = Math.ceil(((oldest.updatedAt - until) / perRound) * 1.25) + 8;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, needed));
}

interface WalkState {
  readonly target: WalkTarget;
  readonly rounds: Round[];
  next: bigint;
  window: number;
  roundsRead: number;
  done: boolean;
  complete: boolean;
  reason: string;
}

export async function walkRounds(
  rpc: Rpc,
  targets: readonly WalkTarget[],
): Promise<Map<Address, Walk>> {
  const states: WalkState[] = targets.map((target) => ({
    target,
    rounds: [],
    next: target.latest.roundId,
    window: FIRST_WINDOW,
    roundsRead: 0,
    done: false,
    complete: false,
    reason: "",
  }));
  for (let step = 0; step < MAX_STEPS; step++) {
    const active = states.filter((s) => !s.done);
    if (active.length === 0) break;
    const batch = rpc.batch({ perCall: READS_PER_CALL });
    const pending = active.map((s) => {
      const ids: bigint[] = [];
      for (let id = s.next; ids.length < s.window && aggregatorRound(id) >= 1n; id--) ids.push(id);
      return { s, ids, handles: ids.map((id) => batch.add(feed.getRoundData(s.target.proxy, id))) };
    });
    await batch.run();
    for (const { s, ids, handles } of pending) {
      for (const handle of handles) record(s, handle);
      if (s.done) continue;
      const last = ids.at(-1);
      if (last === undefined) {
        s.done = true;
        continue;
      }
      s.next = last - 1n;
      const reachedUntil = s.rounds.some((r) => r.updatedAt <= s.target.until);
      if (reachedUntil) {
        s.done = true;
        s.complete = true;
      } else if (aggregatorRound(last) === 1n) {
        s.done = true;
        // Phase 1 began the feed. A later phase has earlier ones behind another aggregator.
        s.complete = phaseOf(last) === 1n;
        s.reason = s.complete ? "" : `the walk reached the start of phase ${phaseOf(last)}`;
      } else {
        // Rounds are kept in the order read, newest first.
        const newest = s.rounds[0];
        const oldest = s.rounds.at(-1);
        s.window =
          newest === undefined || oldest === undefined
            ? MAX_WINDOW
            : nextWindow(newest, oldest, s.rounds.length, s.target.until);
      }
    }
  }
  const walks = new Map<Address, Walk>();
  for (const s of states) {
    const rounds = [...s.rounds].sort((a, b) =>
      a.updatedAt !== b.updatedAt ? a.updatedAt - b.updatedAt : a.roundId < b.roundId ? -1 : 1,
    );
    walks.set(s.target.proxy, {
      rounds,
      roundsRead: s.roundsRead,
      complete: s.complete,
      reason: s.done ? s.reason : `the walk didn't reach its start in ${MAX_STEPS} steps`,
    });
  }
  return walks;
}

// A round the aggregator doesn't have reverts or reads as all zeros, and the walk skips it. A read
// the run couldn't make stops that feed's walk.
function record(s: WalkState, handle: Handle<Round>): void {
  if (s.done) return;
  const read = handle.read();
  if (read.ok) {
    if (read.value.updatedAt > 0) {
      s.rounds.push(read.value);
      s.roundsRead++;
    }
    return;
  }
  if (read.kind === "unavailable") {
    s.done = true;
    s.complete = false;
    s.reason = `getRoundData couldn't be read: ${read.error}`;
  }
}
