// Writes deployments/proof.json, everything vayle.xyz/proof shows, from the chain and the CI:
//   pnpm --filter @vayle/proof proof
// It reads every event of the mainnet market from its deploy block, so ROBINHOOD_RPC_URL has to
// answer eth_getLogs over 10,000 blocks.
import { readFileSync, writeFileSync } from "node:fs";
import { robinhoodChain } from "@vayle/chain-facts/chain";
import { errorText } from "@vayle/chain-facts/rpc-errors";
import { readMarketEvents } from "@vayle/market";
import { createPublicClient, getAddress, http } from "viem";
import { latestCiRun } from "./ci.ts";
import { countsOf, transactionsOf, walletsOf, type TeamWallet } from "./proof.ts";

class MissingRpcUrl extends Error {
  override readonly name = "MissingRpcUrl";
}

const file = (name: string): URL => new URL(`../../../deployments/${name}`, import.meta.url);
const json = (name: string): unknown => JSON.parse(readFileSync(file(name), "utf8"));

// The market check's block and which tokens passed, without the whole file.
function marketCheckSummary(): {
  block: string;
  timestamp: number;
  total: number;
  passed: string[];
} {
  const check = json("market-check.json") as {
    block: { number: string; timestamp: number };
    tokens: { symbol: string; passed: boolean }[];
  };
  return {
    block: check.block.number,
    timestamp: check.block.timestamp,
    total: check.tokens.length,
    passed: check.tokens.filter((t) => t.passed).map((t) => t.symbol),
  };
}

async function main(): Promise<void> {
  const url = process.env["ROBINHOOD_RPC_URL"];
  if (url === undefined || url === "") throw new MissingRpcUrl("set ROBINHOOD_RPC_URL");
  const deployment = json("vayle-robinhood-mainnet.json") as Record<string, string | number>;
  const team = (json("team-wallets.json") as { wallets: TeamWallet[] }).wallets;
  const client = createPublicClient({
    chain: robinhoodChain,
    transport: http(url, { retryCount: 6, retryDelay: 500 }),
  });
  const latest = await client.getBlock({ blockTag: "latest" });
  const market = getAddress(String(deployment["market"]));
  const events = await readMarketEvents(
    client,
    market,
    BigInt(deployment["block"] ?? 0),
    latest.number,
  );
  const proof = {
    generatedAt: new Date().toISOString(),
    chainId: robinhoodChain.id,
    toBlock: Number(latest.number),
    toBlockTime: Number(latest.timestamp),
    deployment,
    team,
    counts: countsOf(events),
    wallets: walletsOf(events, team),
    transactions: transactionsOf(events, team),
    markets: (json("markets.json") as { markets: { symbol: string; token: string }[] }).markets.map(
      (m) => ({ symbol: m.symbol, token: m.token }),
    ),
    marketCheck: marketCheckSummary(),
    ci: latestCiRun(),
  };
  writeFileSync(file("proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  console.log(
    `wrote deployments/proof.json at block ${latest.number.toString()}: ${proof.transactions.length.toString()} transactions, ${proof.wallets.total.toString()} wallets set targets (${proof.wallets.outside.toString()} outside the team)`,
  );
}

main().catch((error: unknown) => {
  console.error(`proof: ${errorText(error)}`);
  process.exitCode = 1;
});
