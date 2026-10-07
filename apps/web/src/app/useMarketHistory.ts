import {
  orderSummary,
  readMarketEvents,
  seriesExpiries,
  weeksOf,
  type MarketEvent,
  type OrderSummary,
} from "@vayle/market";
import { useEffect, useRef, useState } from "react";
import type { Address, PublicClient } from "viem";
import type { AppConfig } from "./config.ts";
import { shortError } from "./failures.ts";

// A holder's history: everything filed under their address and every event of their orders, plus
// what each order has earned. It comes from the indexer when the build names one, and otherwise
// straight from the chain's logs, read from the market's deploy block on. Either way it says
// which, and the block it's current to.

export type HistorySource = "indexer" | "chain";

export interface HistoryRead {
  readonly toBlock: bigint;
  // Oldest first.
  readonly events: readonly MarketEvent[];
  readonly summaries: ReadonlyMap<string, OrderSummary>;
}

export type MarketHistory =
  // No wallet connected.
  | { readonly status: "idle" }
  // The build names neither an indexer nor a deploy block.
  | { readonly status: "off" }
  | { readonly status: "loading"; readonly source: HistorySource }
  | ({
      readonly status: "ready";
      readonly source: HistorySource;
      // Set when the latest refresh failed, so what's shown is as of toBlock, not now.
      readonly problem: string | null;
    } & HistoryRead)
  | { readonly status: "failed"; readonly source: HistorySource; readonly reason: string };

const REFRESH_MS = 30_000;

class HistoryUnavailable extends Error {
  override readonly name = "HistoryUnavailable";
}

function isEvent(value: unknown): value is MarketEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["block_number"] === "number" &&
    typeof v["log_index"] === "number" &&
    typeof v["tx_hash"] === "string" &&
    typeof v["block_time"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["args"] === "object" &&
    v["args"] !== null
  );
}

function isSummary(value: unknown): value is OrderSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    (v["state"] === "active" || v["state"] === "cancelled" || v["state"] === "closed") &&
    typeof v["premiumEarned"] === "string" &&
    /^\d+$/.test(v["premiumEarned"]) &&
    typeof v["weeksFilled"] === "number" &&
    typeof v["skipStreak"] === "number"
  );
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new HistoryUnavailable(`the indexer answered ${response.status}`);
  return response.json();
}

function placedBy(events: readonly MarketEvent[], account: string): Set<string> {
  return new Set(
    events.flatMap((e) =>
      e.name === "OrderPlaced" && e.account === account && e.order_id !== null ? [e.order_id] : [],
    ),
  );
}

async function fromIndexer(
  indexerUrl: string,
  owner: Address,
  signal: AbortSignal,
): Promise<HistoryRead> {
  const payload = (await getJson(`${indexerUrl}/v1/owners/${owner}/events`, signal)) as {
    events?: unknown;
    source?: { toBlock?: unknown };
  };
  const { events, source } = payload;
  if (!Array.isArray(events) || !events.every(isEvent)) {
    throw new HistoryUnavailable("the indexer's events are malformed");
  }
  const toBlock =
    typeof source?.toBlock === "string" && /^\d+$/.test(source.toBlock)
      ? BigInt(source.toBlock)
      : 0n;
  const summaries = new Map<string, OrderSummary>();
  await Promise.all(
    [...placedBy(events, owner.toLowerCase())].map(async (id) => {
      const payload = (await getJson(`${indexerUrl}/v1/orders/${id}`, signal)) as {
        order?: unknown;
      };
      if (isSummary(payload.order)) summaries.set(id, payload.order);
    }),
  );
  return { toBlock, events, summaries };
}

// Every market event read so far, by position, so overlapping reads can't double one up and each
// refresh only reads the blocks after toBlock.
interface ChainCache {
  readonly market: Address;
  toBlock: bigint;
  readonly byPosition: Map<string, MarketEvent>;
}

async function fromChain(
  client: PublicClient,
  config: AppConfig,
  fromBlock: bigint,
  owner: Address,
  cache: ChainCache,
): Promise<HistoryRead> {
  const latest = await client.getBlock({ blockTag: "latest" });
  const start = cache.toBlock === 0n ? fromBlock : cache.toBlock + 1n;
  if (start <= latest.number) {
    for (const e of await readMarketEvents(client, config.market, start, latest.number)) {
      cache.byPosition.set(`${e.block_number}:${e.log_index}`, e);
    }
    if (latest.number > cache.toBlock) cache.toBlock = latest.number;
  }
  const all = [...cache.byPosition.values()].sort(
    (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
  );
  const account = owner.toLowerCase();
  const ids = placedBy(all, account);
  const events = all.filter(
    (e) => e.account === account || (e.order_id !== null && ids.has(e.order_id)),
  );
  const weeks = weeksOf(all);
  const expiries = seriesExpiries(all);
  const now = Number(latest.timestamp);
  const summaries = new Map(
    [...ids].map((id) => [id, orderSummary(id, events, weeks, expiries, now)] as const),
  );
  return { toBlock: cache.toBlock, events, summaries };
}

interface Loaded {
  readonly owner: Address;
  readonly source: HistorySource;
  readonly read: HistoryRead | null;
  readonly problem: string | null;
}

// The chain and the indexer are the external systems: read now, every 30 seconds, and again
// whenever `version` changes after a transaction confirms.
export function useMarketHistory(
  client: PublicClient,
  config: AppConfig,
  owner: Address | null,
  version: number,
): MarketHistory {
  const source: HistorySource | null =
    config.indexerUrl !== null ? "indexer" : config.deployBlock !== null ? "chain" : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const cache = useRef<ChainCache | null>(null);

  useEffect(() => {
    if (owner === null || source === null) return;
    const controller = new AbortController();
    let running = false;
    const load = (): void => {
      if (running) return;
      running = true;
      if (cache.current === null || cache.current.market !== config.market) {
        cache.current = { market: config.market, toBlock: 0n, byPosition: new Map() };
      }
      const read =
        source === "indexer" && config.indexerUrl !== null
          ? fromIndexer(config.indexerUrl, owner, controller.signal)
          : fromChain(client, config, config.deployBlock ?? 0n, owner, cache.current);
      read
        .then(
          (result) => {
            if (!controller.signal.aborted) {
              setLoaded({ owner, source, read: result, problem: null });
            }
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            const problem = shortError(error);
            setLoaded((previous) =>
              previous !== null && previous.owner === owner && previous.source === source
                ? { ...previous, problem }
                : { owner, source, read: null, problem },
            );
          },
        )
        .finally(() => {
          running = false;
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [client, config, owner, source, version]);

  if (owner === null) return { status: "idle" };
  if (source === null) return { status: "off" };
  if (loaded === null || loaded.owner !== owner || loaded.source !== source) {
    return { status: "loading", source };
  }
  if (loaded.read === null) {
    return { status: "failed", source, reason: loaded.problem ?? "history couldn't be read" };
  }
  return { status: "ready", source, problem: loaded.problem, ...loaded.read };
}
