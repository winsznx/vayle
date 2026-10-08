import type { Market } from "@vayle/markets";
import facts from "../../../../deployments/robinhood-mainnet.json" with { type: "json" };

// A market's latest price from its Chainlink feed, read with one eth_call so the landing page
// doesn't load a chain client. Null when the read fails or the answer isn't a price: the page then
// shows the ladder without prices rather than a made-up one.

export interface FeedPrice {
  // USDG base units per raw token, cut not rounded.
  readonly price: bigint;
  readonly round: bigint;
  readonly updatedAt: number;
}

const LATEST_ROUND_DATA = "0xfeaf968c";
const WORD = 64;

function word(hex: string, index: number): bigint {
  return BigInt(`0x${hex.slice(2 + index * WORD, 2 + (index + 1) * WORD)}`);
}

export async function readFeed(
  rpcUrl: string,
  market: Market,
  signal: AbortSignal,
): Promise<FeedPrice | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: market.feed, data: LATEST_ROUND_DATA }, "latest"],
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: string };
  const result = body.result;
  if (typeof result !== "string" || result.length < 2 + WORD * 4) return null;
  const answer = word(result, 1);
  if (answer <= 0n) return null;
  const shift = market.feedDecimals - facts.usdg.decimals;
  const price = shift >= 0 ? answer / 10n ** BigInt(shift) : answer * 10n ** BigInt(-shift);
  return { price, round: word(result, 0), updatedAt: Number(word(result, 3)) };
}
