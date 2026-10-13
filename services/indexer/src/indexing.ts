import { robinhoodChain } from "@vayle/chain-facts/chain";
import { LOG_RANGE, readMarketEvents } from "@vayle/market";
import { createPublicClient, http, type HttpTransportConfig, type PublicClient } from "viem";
import type { ApiDeps } from "./api.ts";
import type { IndexerConfig } from "./config.ts";
import { LogRangeRefused } from "./errors.ts";
import { insertEvents, loadCursor, saveCursor, selectEvents, type Fetch } from "./store.ts";

// What both runtimes share: the chain client, one indexing pass, and what the API reads with. The
// Worker runs a pass from its cron, and the Node process from a timer.

// The most blocks one eth_getLogs may cover on the production RPC, so a chunk is one request.
export const MAX_RANGE = LOG_RANGE;
// Keeping up takes one request a pass. Four let a pass catch up on about an hour of blocks after an
// outage while it stays a handful of requests.
export const MAX_CHUNKS = 4;

export const fetchFn: Fetch = (input, init) => fetch(input, init);

// The indexer makes no eth_call, so there's nothing for Multicall3 batching to fold.
export function chainClient(
  rpcUrl: string,
  rpcFetch?: HttpTransportConfig["fetchFn"],
): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    // The chain's public RPC refuses some requests from Cloudflare's shared addresses as too many,
    // so a pass rides out about a minute of refusals, waiting 0.3 s and then twice as long each time.
    transport: http(rpcUrl, { retryCount: 8, retryDelay: 300, fetchFn: rpcFetch }),
  });
}

// How the production RPC refuses a log range wider than it serves. It's matched by its words,
// because its code (-32614) isn't one providers document for this.
const RANGE_REFUSAL = /eth_getLogs is limited to a [0-9,]+ range/i;

// The RPC's words, if the error or anything it was caused by is that refusal.
function rangeRefusal(error: unknown): string | null {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("message" in current && typeof current.message === "string") {
      const words = RANGE_REFUSAL.exec(current.message)?.[0];
      if (words !== undefined) return words;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return null;
}

export async function indexOnce(
  config: IndexerConfig,
  client: PublicClient,
  storeFetch: Fetch = fetchFn,
): Promise<bigint> {
  const latest = await client.getBlockNumber();
  let cursor = (await loadCursor(config.store, storeFetch)) ?? config.startBlock - 1n;
  for (let chunk = 0; chunk < MAX_CHUNKS && cursor < latest; chunk++) {
    const from = cursor + 1n;
    const to = cursor + MAX_RANGE < latest ? cursor + MAX_RANGE : latest;
    // Block times come from the logs, and a block is looked up only when its logs came without one.
    const events = await readMarketEvents(client, config.market, from, to).catch(
      (error: unknown) => {
        const words = rangeRefusal(error);
        if (words === null) throw error;
        // The RPC's words only: viem's own message names the RPC URL, and with it the key.
        throw new LogRangeRefused(
          `the RPC refused blocks ${from.toString()} to ${to.toString()}: ${words}`,
        );
      },
    );
    await insertEvents(config.store, events, storeFetch);
    cursor = to;
    await saveCursor(config.store, cursor, storeFetch);
  }
  return cursor;
}

export function apiDeps(config: IndexerConfig): ApiDeps {
  return {
    select: (filter) => selectEvents(config.store, filter, fetchFn),
    source: async () => {
      const cursor = await loadCursor(config.store, fetchFn);
      return {
        chainId: config.chainId,
        market: config.market,
        toBlock: cursor?.toString() ?? null,
      };
    },
    now: () => Math.floor(Date.now() / 1000),
  };
}
