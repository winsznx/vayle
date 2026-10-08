// Why a transaction didn't go through, in the holder's words. Errors the market names map to what
// happened; anything else falls back to the first line of the error itself.

const MARKET: Readonly<Record<string, string>> = {
  MarketHalted: "The market is halted, so nothing can change until the halt ends.",
  MarketPaused: "New targets are paused right now. Settling, stopping and withdrawing still work.",
  OraclePaused:
    "This Stock Token's price feed is paused, so new targets and fills wait until it's back.",
  CapExceeded: "That's over the market's current limit for this side. Try a smaller amount.",
  OrderFrozen: "This target is in this week's batch. You can change it once the batch finishes.",
  TargetFrozen:
    "That price is in this week's batch. Pick another, or change it once the batch finishes.",
  OrderAttached:
    "Part of this target is in this week's trade, so its price and amount stay until the week settles.",
  OrderNotActive: "This target isn't active anymore.",
  NotOrderOwner: "This target belongs to another wallet.",
  StrikeNotListed: "That price isn't on this week's ladder.",
  NotALot: "That amount isn't a whole number of lots.",
  NotOnTick: "That payment isn't on the market's price steps.",
  InsufficientClaimable: "There's less ready to withdraw than that. Refresh and try again.",
  WindowStillOpen: "This week's result isn't final yet.",
  WindowClosed: "That week's window has closed.",
  WindowNotOpen: "That week hasn't reached its window yet.",
  SeriesNotSettled: "This week's result isn't final yet.",
  NothingToSettle: "There's nothing to settle on this target.",
  ZeroAmount: "Enter an amount above zero.",
  ExceedsUncommitted: "That's more than the target has free.",
  SafeERC20FailedOperation: "The token transfer failed. Check your balance and approval.",
};

class TransactionReverted extends Error {
  override readonly name = "TransactionReverted";
}

export function reverted(hash: string): Error {
  return new TransactionReverted(
    `The transaction ${hash.slice(0, 10)}… was reverted by the chain.`,
  );
}

function walk(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (
    let e: unknown = error;
    typeof e === "object" && e !== null;
    e = (e as { cause?: unknown }).cause
  ) {
    chain.push(e);
    if (chain.length > 8) break;
  }
  return chain;
}

export function describeFailure(error: unknown): string {
  for (const e of walk(error)) {
    const name = (e as { name?: unknown }).name;
    if (name === "UserRejectedRequestError") return "You declined it in your wallet.";
    if (name === "InsufficientFundsError") return "There isn't enough ETH in the wallet for gas.";
    if (name === "TransactionReverted" && e instanceof Error) return e.message;
    if (name === "ContractFunctionRevertedError") {
      const errorName = (e as { data?: { errorName?: unknown } }).data?.errorName;
      if (typeof errorName === "string") {
        return MARKET[errorName] ?? `The market refused it: ${errorName}.`;
      }
    }
  }
  if (error instanceof Error) return error.message.split("\n")[0] ?? error.message;
  return String(error);
}

// A read error for the screen: viem's short message when there is one, otherwise the first line.
// viem's full message carries the request URL and body, and the URL can hold an RPC key.
export function shortError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof short === "string" && short !== "") return short;
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}
