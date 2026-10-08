// Checks every Stock Token on Robinhood Chain against what a Vayle market needs, at one pinned
// block, and writes deployments/market-check.json:
//   pnpm --filter @vayle/market-check check [--cap-usd <dollars>]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorText } from "@vayle/chain-facts/rpc-errors";
import { formatUnits } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { parseOptions } from "./options.ts";
import { serialize } from "./output.ts";
import { Rpc } from "./rpc.ts";
import { runMarketCheck, type RunResult } from "./run.ts";
import type { Status, TokenResult } from "./types.ts";

const OUTPUT = fileURLToPath(new URL("../../../deployments/market-check.json", import.meta.url));

const MARK: Record<Status, string> = { pass: "pass", fail: "FAIL", not_run: "-" };

function depthUsd(token: TokenResult): number | null {
  const size = token.checks.liquidity.maxSizeWithinLimitRaw;
  if (size === null || token.price === null) return null;
  return Number(formatUnits(BigInt(size), token.decimals)) * Number(token.price.usd);
}

function summary(result: RunResult): string[] {
  const { check } = result;
  const lines: string[] = [];
  const header = [
    "symbol",
    "feed",
    "8056",
    "mult",
    "pause",
    "uid",
    "stale",
    "liq",
    "vol bps",
    "passed",
  ];
  lines.push(header.map((h) => h.padEnd(7)).join(" "));
  for (const t of check.tokens) {
    const c = t.checks;
    const vol = t.realizedVol.annualizedBps === null ? "-" : String(t.realizedVol.annualizedBps);
    lines.push(
      [
        t.symbol,
        ...[c.feed, c.erc8056, c.multiplier, c.pauses, c.uid, c.staleness, c.liquidity].map(
          (x) => MARK[x.status],
        ),
        vol,
        t.passed ? "yes" : "no",
      ]
        .map((cell) => cell.padEnd(7))
        .join(" "),
    );
  }
  const passing = check.tokens
    .filter((t) => t.passed)
    .sort((a, b) => (depthUsd(b) ?? 0) - (depthUsd(a) ?? 0));
  lines.push(
    "",
    `Passed every check, deepest first (USD sellable within ${check.criteria.maxSlippageBps} bps):`,
  );
  for (const t of passing) {
    lines.push(
      `  ${t.symbol.padEnd(6)} $${(depthUsd(t) ?? 0).toFixed(0).padStart(10)}  ${t.checks.liquidity.venue ?? ""} at the cap ${String(t.checks.liquidity.slippageBps)} bps  vol ${String(t.realizedVol.annualizedBps)} bps`,
    );
  }
  lines.push("", `RPC calls: ${result.calls}`);
  for (const s of result.stages) lines.push(`  ${s.name}: ${s.calls}`);
  for (const s of result.skipped) lines.push(`skipped ${s.symbol}: ${s.reason}`);
  for (const n of result.notes) lines.push(`note: ${n}`);
  return lines;
}

async function main(args: readonly string[]): Promise<void> {
  const options = parseOptions(args, facts.usdg.decimals);
  const { rpc, timestamp } = await Rpc.connect(process.env);
  const result = await runMarketCheck(rpc, timestamp, options, new Date());
  writeFileSync(OUTPUT, serialize(result.check));
  for (const line of summary(result)) console.log(line);
  console.log(`wrote ${OUTPUT} at block ${result.check.block.number}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`market-check: ${errorText(error)}`);
  process.exitCode = 1;
}
