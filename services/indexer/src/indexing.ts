import { toMarketEvents } from "@vayle/market";
import type { PublicClient } from "viem";
import type { ApiDeps } from "./api.ts";
import type { IndexerConfig } from "./config.ts";
import { insertEvents, loadCursor, saveCursor, selectEvents, type Fetch } from "./store.ts";

// What both runtimes share: one indexing pass, and what the API reads with. The Worker runs a pass
// from its cron, and the Node process from a timer.

// Logs are read in chunks of this many blocks, at most this many chunks a pass.
export const MAX_RANGE = 5_000n;
export const MAX_CHUNKS = 4;

export const fetchFn: Fetch = (input, init) => fetch(input, init);

export async function indexOnce(config: IndexerConfig, client: PublicClient): Promise<bigint> {
  const latest = await client.getBlockNumber();
  let cursor = (await loadCursor(config.store, fetchFn)) ?? config.startBlock - 1n;
  for (let chunk = 0; chunk < MAX_CHUNKS && cursor < latest; chunk++) {
    const to = cursor + MAX_RANGE < latest ? cursor + MAX_RANGE : latest;
    const logs = await client.getLogs({
      address: config.market,
      fromBlock: cursor + 1n,
      toBlock: to,
    });
    const blocks = [...new Set(logs.map((l) => l.blockNumber))];
    const times = new Map<bigint, number>();
    for (const number of blocks) {
      const block = await client.getBlock({ blockNumber: number });
      times.set(number, Number(block.timestamp));
    }
    await insertEvents(config.store, toMarketEvents(logs, times), fetchFn);
    cursor = to;
    await saveCursor(config.store, cursor, fetchFn);
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
