import { parseUnits } from "viem";
import { UsageError } from "./errors.ts";

export const USAGE = "usage: pnpm --filter @vayle/market-check check [--cap-usd <dollars>]";
const DEFAULT_CAP_USD = "2500";

const DOLLARS = /^\d+(\.\d+)?$/;

export interface Options {
  // The cap as given, for the record.
  readonly capUsd: number;
  // The cap in USDG base units.
  readonly capUsdBase: bigint;
}

export function parseOptions(args: readonly string[], usdgDecimals: number): Options {
  let capText = DEFAULT_CAP_USD;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cap-usd") {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError(`--cap-usd needs an amount. ${USAGE}`);
      capText = value;
      i++;
      continue;
    }
    throw new UsageError(`unknown argument ${String(arg)}. ${USAGE}`);
  }
  const decimals = capText.split(".")[1]?.length ?? 0;
  if (!DOLLARS.test(capText) || decimals > usdgDecimals) {
    throw new UsageError(
      `--cap-usd takes dollars with at most ${usdgDecimals} decimals, not ${capText}`,
    );
  }
  const capUsdBase = parseUnits(capText, usdgDecimals);
  if (capUsdBase === 0n) throw new UsageError("--cap-usd takes an amount above zero");
  return { capUsd: Number(capText), capUsdBase };
}
