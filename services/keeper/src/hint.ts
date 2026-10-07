import {
  BaseError,
  ContractFunctionRevertedError,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";

const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);

// Round IDs are (phase << 64) | aggregator round.
const AGGREGATOR_ROUND_MASK = (1n << 64n) - 1n;
// A close is minutes to a few days back, and the feed updates on 0.5% moves.
export const MAX_ROUNDS_BACK = 500;
// Rounds read per Multicall3 call. The epoch is usually created minutes after the close, a few
// rounds back, so the first window almost always holds the answer.
export const ROUND_WINDOW = 64;

// When each of `ids` was updated, in the same order, with null for a round the feed doesn't have.
export type ProbeRounds = (ids: readonly bigint[]) => Promise<readonly (bigint | null)[]>;

// The newest round at or before `close`, walking back from `latest` a window at a time. The
// answer is the one a round-at-a-time walk gives: rounds are checked newest first, the walk stops
// at the phase's first round, and it never looks more than MAX_ROUNDS_BACK back.
export async function searchRounds(
  latest: bigint,
  close: bigint,
  probe: ProbeRounds,
): Promise<bigint | null> {
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
    const updated = ids.length === 0 ? [] : await probe(ids);
    for (const [i, id] of ids.entries()) {
      const at = updated[i] ?? null;
      if (at !== null && at <= close) return id;
    }
    if (phaseStart) return null;
  }
  return null;
}

async function updatedAt(
  client: PublicClient,
  feed: Address,
  id: bigint,
  blockNumber: bigint,
): Promise<bigint | null> {
  try {
    const round = await client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "getRoundData",
      args: [id],
      blockNumber,
    });
    return round[3] === 0n ? null : round[3];
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

// The feed's last round at or before `close`, searched back from the latest round in the newest
// phase. That's the round the price adapter accepts. Null when none is found within the bound,
// which leaves the epoch uncreated and the watcher alerting. Every read is at `blockNumber`, and a
// window's reads start together, so a batching client sends each window as one call.
export async function roundHint(
  client: PublicClient,
  feed: Address,
  close: number,
  blockNumber: bigint,
): Promise<bigint | null> {
  const [latest] = await client.readContract({
    address: feed,
    abi: feedAbi,
    functionName: "latestRoundData",
    blockNumber,
  });
  return searchRounds(latest, BigInt(close), (ids) =>
    Promise.all(ids.map((id) => updatedAt(client, feed, id, blockNumber))),
  );
}
