import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  lastRoundAtOrBefore,
  MAX_ROUNDS_BACK,
  ROUND_WINDOW,
  type ProbeRounds,
  type Round,
} from "../src/close.ts";

// Phase 1's round r has ID (1 << 64) | r, the shape the NVDA feed's IDs have.
const PHASE_1 = 1n << 64n;
const START = 1_790_000_000;
const SPACING = 600;

// A phase with rounds 1..count, ten minutes apart, each answering its own number. Rounds in
// `missing` answer as the feed does for a round it doesn't have.
function feed(count: number, missing: ReadonlySet<number> = new Set()): Map<bigint, Round | null> {
  const rounds = new Map<bigint, Round | null>();
  for (let r = 1; r <= count; r++) {
    const roundId = PHASE_1 + BigInt(r);
    rounds.set(
      roundId,
      missing.has(r) ? null : { roundId, answer: BigInt(r), updatedAt: START + r * SPACING },
    );
  }
  return rounds;
}

function prober(rounds: ReadonlyMap<bigint, Round | null>): {
  probe: ProbeRounds;
  calls: bigint[][];
} {
  const calls: bigint[][] = [];
  const probe: ProbeRounds = (ids) => {
    calls.push([...ids]);
    return Promise.resolve(ids.map((id) => rounds.get(id) ?? null));
  };
  return { probe, calls };
}

// The search one round at a time.
async function oneAtATime(
  latest: bigint,
  close: number,
  probe: ProbeRounds,
): Promise<Round | null> {
  for (let back = 0; back < MAX_ROUNDS_BACK; back++) {
    const id = latest - BigInt(back);
    if ((id & (PHASE_1 - 1n)) === 0n) return null;
    const [round] = await probe([id]);
    if (round !== null && round !== undefined && round.updatedAt <= close) return round;
  }
  return null;
}

// Closes on, just before and just after rounds at every distance where a window starts or ends.
function closesAround(count: number): number[] {
  const backs = [0, 1, 62, 63, 64, 65, 127, 128, 129, 447, 448, 498, 499, 500, 501];
  const closes = [START, START + (count + 1) * SPACING];
  for (const back of backs) {
    const round = count - back;
    if (round < 1) continue;
    const at = START + round * SPACING;
    closes.push(at - 1, at, at + 1);
  }
  return closes;
}

describe("lastRoundAtOrBefore", () => {
  it("finds the round a one-at-a-time walk finds, at every window edge", async () => {
    // #given: phases short and long, whole and with rounds missing, closes at every window edge
    const cases: { count: number; missing: Set<number> }[] = [];
    for (const count of [1, 2, 63, 64, 65, 128, 129, 499, 500, 501, 700]) {
      cases.push({ count, missing: new Set() });
      cases.push({
        count,
        missing: new Set(Array.from({ length: count }, (_, i) => i + 1).filter((r) => r % 7 === 0)),
      });
    }
    const windowed: (Round | null)[] = [];
    const walked: (Round | null)[] = [];
    // #when
    for (const { count, missing } of cases) {
      const rounds = feed(count, missing);
      const latest = PHASE_1 + BigInt(count);
      for (const close of closesAround(count)) {
        windowed.push(await lastRoundAtOrBefore(latest, close, prober(rounds).probe));
        walked.push(await oneAtATime(latest, close, prober(rounds).probe));
      }
    }
    // #then
    assert.deepEqual(windowed, walked);
  });

  it("answers with the close's round, from one call when it's in the first window", async () => {
    // #given: the close falls between rounds 280 and 281, in the first window back from round 300
    const { probe, calls } = prober(feed(300));
    const close = START + 280 * SPACING + 1;
    // #when
    const round = await lastRoundAtOrBefore(PHASE_1 + 300n, close, probe);
    // #then
    assert.deepEqual([round?.answer, calls.length], [280n, 1]);
  });

  it("reads the next window only when the first holds no round at or before the close", async () => {
    // #given: the close falls one round past the first window
    const count = 300;
    const { probe, calls } = prober(feed(count));
    const close = START + (count - ROUND_WINDOW) * SPACING;
    // #when
    const round = await lastRoundAtOrBefore(PHASE_1 + BigInt(count), close, probe);
    // #then
    assert.deepEqual([round?.roundId, calls.length], [PHASE_1 + BigInt(count - ROUND_WINDOW), 2]);
  });

  it("stops at the phase's first round without asking for round zero", async () => {
    // #given: 30 rounds, all after the close
    const { probe, calls } = prober(feed(30));
    // #when
    const round = await lastRoundAtOrBefore(PHASE_1 + 30n, START, probe);
    // #then
    assert.deepEqual([round, calls.flat().includes(PHASE_1)], [null, false]);
  });

  it("never looks more than 500 rounds back", async () => {
    // #given: 700 rounds, all after the close
    const { probe, calls } = prober(feed(700));
    const latest = PHASE_1 + 700n;
    // #when
    const round = await lastRoundAtOrBefore(latest, START, probe);
    // #then
    const probed = calls.flat();
    assert.deepEqual(
      [round, probed.length, probed.at(-1)],
      [null, MAX_ROUNDS_BACK, latest - BigInt(MAX_ROUNDS_BACK - 1)],
    );
  });
});
