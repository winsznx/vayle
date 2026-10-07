import { sessionCalendarAbi, vayleMarketAbi } from "@vayle/abi";
import { BaseError, decodeErrorResult, type Abi, type Hex } from "viem";
import { duration, moment } from "./view.ts";

// Every named error a market call can revert with. The calendar's are here because the market
// passes its reverts through, like NoCloseAfter once the schedule runs out.
const ERRORS: Abi = [...vayleMarketAbi, ...sessionCalendarAbi].filter(
  (item) => item.type === "error",
);

// A cause chain is a handful of errors deep. The bound only stops a provider whose error is its
// own cause.
const MAX_CAUSES = 16;

export interface Refusal {
  readonly name: string;
  readonly args: readonly unknown[];
}

function isRevertData(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{2})*$/.test(value);
}

// Revert data can sit on any error in the chain, depending on who wrapped it: `raw` on viem's
// decoded contract error, `data` on an RPC error, and a level deeper on wallets that put the
// node's error inside their own.
function payloads(error: unknown): Hex[] {
  const found: Hex[] = [];
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_CAUSES && typeof current === "object" && current !== null;
    depth++
  ) {
    const { raw, data, cause } = current as { raw?: unknown; data?: unknown; cause?: unknown };
    const nested =
      typeof data === "object" && data !== null ? (data as { data?: unknown }).data : undefined;
    for (const candidate of [raw, data, nested]) if (isRevertData(candidate)) found.push(candidate);
    current = cause;
  }
  return found;
}

function decoded(data: Hex): Refusal | null {
  try {
    const { errorName, args } = decodeErrorResult({ abi: ERRORS, data });
    // An error without arguments, like NotHalted(), decodes with none at all.
    return { name: errorName, args: args ?? [] };
  } catch (error) {
    // Data no Vayle contract sends. The caller shows the error as it came instead.
    if (error instanceof BaseError) return null;
    throw error;
  }
}

// The contract's named error inside whatever a read or a send threw, or null when there's none,
// like a request the wallet rejected.
export function refusalOf(error: unknown): Refusal | null {
  for (const data of payloads(error)) {
    const refusal = decoded(data);
    if (refusal !== null) return refusal;
  }
  return null;
}

// Vayle's errors only carry numbers, addresses, hashes and flags.
function show(value: unknown): string {
  const plain =
    typeof value === "bigint" ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean";
  return plain ? String(value) : "…";
}

// The market's refusals of a checkpoint or a close observation, as sentences. `lookback` is the
// market's LIVENESS_LOOKBACK, so the sentence states the rule the market applied.
export function refusalText(refusal: Refusal, lookback: bigint): string {
  const [first] = refusal.args;
  if (refusal.name === "NotNearAClose" && typeof first === "bigint") {
    return `The market takes a close observation only in the ${duration(lookback)} before a close. The next close is ${moment(first)}, so it takes one from ${moment(first - lookback)}.`;
  }
  if (refusal.name === "NoCloseAfter" && typeof first === "bigint") {
    return `The market's calendar has no close after ${moment(first)}, so there's no close to observe until more weeks are added.`;
  }
  if (refusal.name === "NotListed" && typeof first === "string") {
    return `The market doesn't list ${first}, so it has no close to observe.`;
  }
  if (refusal.name === "NotAStockToken" && typeof first === "string") {
    return `The market couldn't read whether ${first} has its price feed paused, so it can't record an observation.`;
  }
  return `The market refused it with ${refusal.name}(${refusal.args.map(show).join(", ")}).`;
}
