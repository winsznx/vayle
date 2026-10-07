import { toMarketEvents } from "@vayle/market";
import { createPublicClient, http, type PublicClient } from "viem";
import { handle } from "./api.ts";
import { loadConfig, type IndexerConfig } from "./config.ts";
import { insertEvents, loadCursor, saveCursor, selectEvents, type Fetch } from "./store.ts";

// Logs are read in chunks of this many blocks, at most this many chunks a run.
export const MAX_RANGE = 5_000n;
export const MAX_CHUNKS = 4;

type Env = Readonly<Record<string, string | undefined>>;

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

const fetchFn: Fetch = (input, init) => fetch(input, init);

async function indexOnce(config: IndexerConfig, client: PublicClient): Promise<bigint> {
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

// One Worker: the cron indexes, and requests read the API.
export default {
  scheduled(_controller: unknown, env: Env, ctx: ScheduledContext): void {
    const config = loadConfig(env);
    const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 3 }) });
    ctx.waitUntil(indexOnce(config, client));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    return handle(request, {
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
    });
  },
};
