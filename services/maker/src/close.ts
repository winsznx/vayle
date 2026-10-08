import {
  BaseError,
  ContractFunctionRevertedError,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

// A market's price at a close: its feed's last round at or before it, found the way the keeper finds
// an epoch's round hint. Exercise judges the money on it, so a week ends in the money only if its
// close did, whatever the feed does in the window after.

const feedAbi = parseAbi([
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);

// Round IDs are (phase << 64) | aggregator round.
const AGGREGATOR_ROUND_MASK = (1n << 64n) - 1n;
// A close the maker exercises on is hours to a few days back, and feeds update on 0.5% moves.
export const MAX_ROUNDS_BACK = 500;
// Rounds read per Multicall3 call. A window opens at its close, so the first holds the answer.
export const ROUND_WINDOW = 64;

export interface Round {
  readonly roundId: bigint;
  readonly answer: bigint;
  // When the round landed, in block time.
  readonly updatedAt: number;
}

// Each of `ids` in the same order, with null for a round the feed doesn't have.
export type ProbeRounds = (ids: readonly bigint[]) => Promise<readonly (Round | null)[]>;

// The newest round at or before `close`, walking back from `latest` a window at a time: rounds are
// checked newest first, the walk stops at the phase's first round, and it never looks more than
// MAX_ROUNDS_BACK back. Null when none is found, and the maker then doesn't exercise that week.
export async function lastRoundAtOrBefore(
  latest: bigint,
  close: number,
  probe: ProbeRounds,
): Promise<Round | null> {
  for (let back = 0; back < MAX_ROUNDS_BACK; back += ROUND_WINDOW) {
    const ids: bigint[] = [];
    let phaseStart = false;
    for (let i = back; i < Math.min(back + ROUND_WINDOW, MAX_ROUNDS_BACK); i++) {
      const id = latest - BigInt(i);
      if ((id & AGGREGATOR_ROUND_MASK) === 0n) {
        phaseStart = true;
        break;
      }
      ids.push(id);
    }
    const rounds = ids.length === 0 ? [] : await probe(ids);
    for (const round of rounds) {
      if (round !== null && round.updatedAt <= close) return round;
    }
    if (phaseStart) return null;
  }
  return null;
}

async function roundAt(
  client: PublicClient,
  feed: Address,
  id: bigint,
  blockNumber: bigint,
): Promise<Round | null> {
  try {
    const [roundId, answer, , updatedAt] = await client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "getRoundData",
      args: [id],
      blockNumber,
    });
    return updatedAt === 0n ? null : { roundId, answer, updatedAt: Number(updatedAt) };
  } catch (error) {
    // A round the aggregator doesn't have reverts. Anything else is a real failure.
    if (
      error instanceof BaseError &&
      error.walk((e) => e instanceof ContractFunctionRevertedError)
    ) {
      return null;
    }
    throw error;
  }
}

// The answer at each of `closes` on `feed`, searched back from its latest round, `latest`. The
// searches start together and every read is at `blockNumber`, so a batching client sends each round
// of windows, every close's and every market's, as one call.
export async function closeAnswers(
  client: PublicClient,
  feed: Address,
  latest: bigint,
  closes: readonly number[],
  blockNumber: bigint,
): Promise<Map<number, bigint | null>> {
  const probe: ProbeRounds = (ids) =>
    Promise.all(ids.map((id) => roundAt(client, feed, id, blockNumber)));
  const rounds = await Promise.all(
    closes.map((close) => lastRoundAtOrBefore(latest, close, probe)),
  );
  return new Map(closes.map((close, i) => [close, rounds[i]?.answer ?? null]));
}
