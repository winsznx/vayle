// Prints the calldata the app and the fallback page send for one action, so a fork test can run a
// holder's flow through exactly these builders:
//   node src/cli.ts <action> <args...>
import { getAddress } from "viem";
import {
  approve,
  cancelOrder,
  exercise,
  finalize,
  placeOrder,
  settleOrder,
  updateOrder,
  withdraw,
  type Call,
} from "./calls.ts";
import { seriesId } from "./series.ts";

class UsageError extends Error {
  override readonly name = "UsageError";
}

// The market's address doesn't change the calldata, so any address stands in for it here. The
// seriesId action prints an ID instead, as a 32-byte word.
const MARKET = getAddress("0x0000000000000000000000000000000000000001");

function arg(args: readonly string[], i: number): string {
  const value = args[i];
  if (value === undefined) throw new UsageError(`missing argument ${i + 1}`);
  return value;
}

function build(action: string, a: readonly string[]): Call {
  switch (action) {
    case "approve":
      return approve(getAddress(arg(a, 0)), getAddress(arg(a, 1)), BigInt(arg(a, 2)));
    case "placeOrder": {
      const side = Number(arg(a, 1));
      if (side !== 0 && side !== 1) throw new UsageError("side is 0 (sell) or 1 (buy)");
      return placeOrder(MARKET, {
        asset: getAddress(arg(a, 0)),
        side,
        target: BigInt(arg(a, 2)),
        minPremium: BigInt(arg(a, 3)),
        size: BigInt(arg(a, 4)),
        flip: arg(a, 5) === "true",
        flipTarget: BigInt(arg(a, 6)),
      });
    }
    case "updateOrder":
      return updateOrder(
        MARKET,
        BigInt(arg(a, 0)),
        BigInt(arg(a, 1)),
        arg(a, 2) === "true",
        BigInt(arg(a, 3)),
      );
    case "cancelOrder":
      return cancelOrder(MARKET, BigInt(arg(a, 0)));
    case "settleOrder":
      return settleOrder(MARKET, BigInt(arg(a, 0)));
    case "finalize":
      return finalize(MARKET, BigInt(arg(a, 0)));
    case "exercise":
      return exercise(MARKET, BigInt(arg(a, 0)), BigInt(arg(a, 1)));
    case "withdraw":
      return withdraw(MARKET, getAddress(arg(a, 0)), BigInt(arg(a, 1)));
    case "seriesId": {
      const id = seriesId({
        chainId: BigInt(arg(a, 0)),
        asset: getAddress(arg(a, 1)),
        side: Number(arg(a, 2)),
        strike: BigInt(arg(a, 3)),
        expiry: BigInt(arg(a, 4)),
        windowLength: Number(arg(a, 5)),
        collateralToken: getAddress(arg(a, 6)),
      });
      return { to: MARKET, data: `0x${id.toString(16).padStart(64, "0")}` };
    }
    default:
      throw new UsageError(`unknown action ${action}`);
  }
}

try {
  const [action, ...rest] = process.argv.slice(2);
  if (action === undefined) throw new UsageError("usage: cli.ts <action> <args...>");
  process.stdout.write(build(action, rest).data);
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
