import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  firstEpochHint,
  MAX_ROUNDS_BACK,
  ROUND_WINDOW,
  searchRounds,
  type ProbeRounds,
} from "../src/hint.ts";

// Phase 1's round r has ID (1 << 64) | r, the shape the NVDA feed's IDs have.
const PHASE_1 = 1n << 64n;
const START = 1_790_000_000n;
const SPACING = 600n;

// A phase with rounds 1..count, ten minutes apart. Rounds in `missing` answer as the feed does for
// a round it doesn't have.
function feed(count: number, missing: ReadonlySet<number> = new Set()): Map<bigint, bigint | null> {
  const rounds = new Map<bigint, bigint | null>();
  for (let r = 1; r <= count; r++) {
    rounds.set(PHASE_1 + BigInt(r), missing.has(r) ? null : START + BigInt(r) * SPACING);
  }
  return rounds;
}

function prober(rounds: ReadonlyMap<bigint, bigint | null>): {
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

// The search as it ran before windows: one round at a time.
async function oneAtATime(
  latest: bigint,
  close: bigint,
  probe: ProbeRounds,
): Promise<bigint | null> {
  for (let back = 0; back < MAX_ROUNDS_BACK; back++) {
    const id = latest - BigInt(back);
    if ((id & (PHASE_1 - 1n)) === 0n) return null;
    const [at] = await probe([id]);
    if (at !== null && at !== undefined && at <= close) return id;
  }
  return null;
}

// Closes on, just before and just after rounds at every distance where a window starts or ends.
function closesAround(count: number): bigint[] {
  const backs = [0, 1, 62, 63, 64, 65, 127, 128, 129, 447, 448, 498, 499, 500, 501];
  const closes = [START, START + BigInt(count + 1) * SPACING];
  for (const back of backs) {
    const round = count - back;
    if (round < 1) continue;
    const at = START + BigInt(round) * SPACING;
    closes.push(at - 1n, at, at + 1n);
  }
  return closes;
}

describe("searchRounds", () => {
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
    const windowed: (bigint | null)[] = [];
    const walked: (bigint | null)[] = [];
    // #when
    for (const { count, missing } of cases) {
      const rounds = feed(count, missing);
      const latest = PHASE_1 + BigInt(count);
      for (const close of closesAround(count)) {
        windowed.push(await searchRounds(latest, close, prober(rounds).probe));
        walked.push(await oneAtATime(latest, close, prober(rounds).probe));
      }
    }
    // #then
    assert.deepEqual(windowed, walked);
  });

  it("answers in one call when the round is in the first window", async () => {
    // #given: the close falls on the oldest round of the first window
    const count = 300;
    const { probe, calls } = prober(feed(count));
    const close = START + BigInt(count - (ROUND_WINDOW - 1)) * SPACING;
    // #when
    const hint = await searchRounds(PHASE_1 + BigInt(count), close, probe);
    // #then
    assert.deepEqual([hint, calls.length], [PHASE_1 + BigInt(count - (ROUND_WINDOW - 1)), 1]);
  });

  it("reads the next window only when the first holds no round at or before the close", async () => {
    // #given: the close falls one round past the first window
    const count = 300;
    const { probe, calls } = prober(feed(count));
    const close = START + BigInt(count - ROUND_WINDOW) * SPACING;
    // #when
    const hint = await searchRounds(PHASE_1 + BigInt(count), close, probe);
    // #then
    assert.deepEqual([hint, calls.length], [PHASE_1 + BigInt(count - ROUND_WINDOW), 2]);
  });

  it("stops at the phase's first round without asking for round zero", async () => {
    // #given: 30 rounds, all after the close
    const { probe, calls } = prober(feed(30));
    // #when
    const hint = await searchRounds(PHASE_1 + 30n, START, probe);
    // #then
    assert.deepEqual([hint, calls.flat().includes(PHASE_1)], [null, false]);
  });

  it("never looks more than 500 rounds back", async () => {
    // #given: 700 rounds, all after the close
    const { probe, calls } = prober(feed(700));
    const latest = PHASE_1 + 700n;
    // #when
    const hint = await searchRounds(latest, START, probe);
    // #then
    const probed = calls.flat();
    assert.deepEqual(
      [hint, probed.length, probed.at(-1)],
      [null, MAX_ROUNDS_BACK, latest - BigInt(MAX_ROUNDS_BACK - 1)],
    );
  });
});

describe("firstEpochHint", () => {
  // Wed Oct 7 at 11:01:06 ET, when round 1188 landed.
  const LANDED = 1_791_385_266;

  it("is the latest round when it landed before this second", () => {
    // #when
    const hint = firstEpochHint(
      { roundId: PHASE_1 + 1188n, updatedAt: BigInt(LANDED) },
      LANDED + 1,
    );
    // #then
    assert.equal(hint, PHASE_1 + 1188n);
  });

  it("is the round before when the latest landed this second", () => {
    // #when
    const hint = firstEpochHint({ roundId: PHASE_1 + 1188n, updatedAt: BigInt(LANDED) }, LANDED);
    // #then
    assert.equal(hint, PHASE_1 + 1187n);
  });

  it("waits when the latest is its phase's first round and landed this second", () => {
    // #given: the first round of phase 2
    const roundId = (2n << 64n) + 1n;
    // #when
    const hint = firstEpochHint({ roundId, updatedAt: BigInt(LANDED) }, LANDED);
    // #then
    assert.equal(hint, null);
  });
});
