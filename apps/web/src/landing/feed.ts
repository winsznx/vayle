import facts from "../../../../deployments/robinhood-mainnet.json" with { type: "json" };

// NVDA's latest price from the Chainlink feed, read with one eth_call so the landing page doesn't
// load a chain library. Null when there's no RPC configured or the read fails: the page then shows
// the ladder without prices rather than a made-up one.

export interface FeedPrice {
  // USDG-style base units per raw token, 6 decimals, cut not rounded.
  readonly price: bigint;
  readonly round: bigint;
  readonly updatedAt: number;
}

const LATEST_ROUND_DATA = "0xfeaf968c";
const WORD = 64;

function word(hex: string, index: number): bigint {
  return BigInt(`0x${hex.slice(2 + index * WORD, 2 + (index + 1) * WORD)}`);
}

export async function readFeed(rpcUrl: string, signal: AbortSignal): Promise<FeedPrice | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: facts.nvdaUsdFeed.proxy, data: LATEST_ROUND_DATA }, "latest"],
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { result?: string };
  const result = body.result;
  if (typeof result !== "string" || result.length < 2 + WORD * 4) return null;
  const answer = word(result, 1);
  if (answer <= 0n) return null;
  const scale = 10n ** BigInt(facts.nvdaUsdFeed.decimals - facts.usdg.decimals);
  return { price: answer / scale, round: word(result, 0), updatedAt: Number(word(result, 3)) };
}
