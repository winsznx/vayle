import { parseUnits } from "viem";
import type { AdvanceOptions } from "./week.ts";

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export const USAGE =
  "usage: pnpm fork up | pnpm fork advance [minutes] [--without-keeper] [--close-at <price>] | pnpm fork bids";

const PRICE = /^\d+(\.\d+)?$/;

// `pnpm fork advance` arguments: how far to go, whether the keeper runs, and the price the next
// close crossed should have instead of the latest real one, in the feed's decimals.
export function advanceOptions(args: readonly string[], feedDecimals: number): AdvanceOptions {
  let minutes: number | null = null;
  let keeper = true;
  let closeAt: bigint | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--without-keeper") {
      keeper = false;
      continue;
    }
    if (arg === "--close-at") {
      const price = args[i + 1];
      const decimals = price?.split(".")[1]?.length ?? 0;
      if (price === undefined || !PRICE.test(price) || decimals > feedDecimals) {
        throw new UsageError(
          `--close-at takes a price in dollars, like 250.00, not ${String(price)}`,
        );
      }
      closeAt = parseUnits(price, feedDecimals);
      if (closeAt === 0n) throw new UsageError("--close-at takes a price above zero");
      i++;
      continue;
    }
    const value = Number(arg);
    if (!Number.isInteger(value) || value <= 0 || minutes !== null) {
      throw new UsageError(`advance takes a whole number of minutes and flags, not ${String(arg)}`);
    }
    minutes = value;
  }
  return { minutes, keeper, closeAt };
}
