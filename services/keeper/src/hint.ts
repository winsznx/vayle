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

async function updatedAt(client: PublicClient, feed: Address, id: bigint): Promise<bigint | null> {
  try {
    const round = await client.readContract({
      address: feed,
      abi: feedAbi,
      functionName: "getRoundData",
      args: [id],
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
// which leaves the epoch uncreated and the watcher alerting.
export async function roundHint(
  client: PublicClient,
  feed: Address,
  close: number,
): Promise<bigint | null> {
  const [latest] = await client.readContract({
    address: feed,
    abi: feedAbi,
    functionName: "latestRoundData",
  });
  for (let back = 0; back < MAX_ROUNDS_BACK; back++) {
    const id = latest - BigInt(back);
    if ((id & AGGREGATOR_ROUND_MASK) === 0n) return null;
    const at = await updatedAt(client, feed, id);
    if (at !== null && at <= BigInt(close)) return id;
  }
  return null;
}
