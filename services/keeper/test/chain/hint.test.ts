import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import facts from "../../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { MissingSetting } from "../../src/errors.ts";
import { roundHint } from "../../src/hint.ts";

// Runs against the real NVDA feed. Without an RPC URL it fails, so it can't pass by not running.
const url = process.env["ROBINHOOD_RPC_URL"];
if (url === undefined || url === "") throw new MissingSetting("set ROBINHOOD_RPC_URL");
const client = createPublicClient({ transport: http(url, { retryCount: 6, retryDelay: 500 }) });
const feed = getAddress(facts.nvdaUsdFeed.proxy);
const feedAbi = parseAbi([
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);

async function updatedAt(id: bigint): Promise<bigint> {
  const round = await client.readContract({
    address: feed,
    abi: feedAbi,
    functionName: "getRoundData",
    args: [id],
  });
  return round[3];
}

describe("roundHint against the real feed", () => {
  // Fri Sep 25 and Fri Oct 2 2026, 16:00 ET.
  for (const close of [1_790_366_400, 1_790_971_200]) {
    it(`finds the last round at or before ${new Date(close * 1000).toISOString()}`, async () => {
      // #when
      const hint = await roundHint(client, feed, close);
      // #then: the hint landed at or before the close and the next round after it
      assert.ok(hint !== null);
      const [at, next] = await Promise.all([updatedAt(hint), updatedAt(hint + 1n)]);
      assert.deepEqual([at <= BigInt(close), next > BigInt(close)], [true, true]);
    });
  }
});
