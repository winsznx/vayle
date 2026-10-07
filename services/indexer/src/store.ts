import type { StoreConfig } from "./config.ts";
import { StoreRequestFailed, StoreRowMalformed } from "./errors.ts";
import type { EventRow } from "./rows.ts";
import type { StoredEvent } from "./summary.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const CURSOR_ID = "market";

function headers(store: StoreConfig, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: store.serviceKey,
    authorization: `Bearer ${store.serviceKey}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function send(fetchFn: Fetch, url: string, init: RequestInit): Promise<Response> {
  const response = await fetchFn(url, init);
  if (!response.ok) {
    throw new StoreRequestFailed(
      `${init.method ?? "GET"} ${url.split("?")[0] ?? url}: HTTP ${response.status}`,
    );
  }
  return response;
}

// Inserting a row that's already there is a no-op, so replaying a block range is safe.
export function insertRequest(
  store: StoreConfig,
  rows: readonly EventRow[],
): { url: string; init: RequestInit } {
  return {
    url: `${store.url}/rest/v1/market_events?on_conflict=block_number,log_index`,
    init: {
      method: "POST",
      headers: headers(store, { prefer: "resolution=ignore-duplicates,return=minimal" }),
      body: JSON.stringify(rows),
    },
  };
}

export async function insertEvents(
  store: StoreConfig,
  rows: readonly EventRow[],
  fetchFn: Fetch,
): Promise<void> {
  if (rows.length === 0) return;
  const { url, init } = insertRequest(store, rows);
  await send(fetchFn, url, init);
}

export async function loadCursor(store: StoreConfig, fetchFn: Fetch): Promise<bigint | null> {
  const response = await send(
    fetchFn,
    `${store.url}/rest/v1/indexer_state?id=eq.${CURSOR_ID}&select=cursor_block`,
    { method: "GET", headers: headers(store) },
  );
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new StoreRowMalformed("expected an array of rows");
  const row: unknown = rows[0];
  if (row === undefined) return null;
  if (typeof row !== "object" || row === null || !("cursor_block" in row)) {
    throw new StoreRowMalformed("cursor row is malformed");
  }
  const cursor = row.cursor_block;
  if (typeof cursor !== "string" && typeof cursor !== "number") {
    throw new StoreRowMalformed("cursor_block isn't a block number");
  }
  return BigInt(cursor);
}

export async function saveCursor(
  store: StoreConfig,
  cursor: bigint,
  fetchFn: Fetch,
): Promise<void> {
  await send(fetchFn, `${store.url}/rest/v1/indexer_state?on_conflict=id`, {
    method: "POST",
    headers: headers(store, { prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: CURSOR_ID, cursor_block: cursor.toString() }),
  });
}

function isStoredEvent(value: unknown): value is StoredEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["block_number"] === "number" &&
    typeof v["log_index"] === "number" &&
    typeof v["name"] === "string" &&
    typeof v["args"] === "object"
  );
}

// Market events matching a PostgREST filter, oldest first.
export async function selectEvents(
  store: StoreConfig,
  filter: string,
  fetchFn: Fetch,
): Promise<StoredEvent[]> {
  const query = `${filter}${filter === "" ? "" : "&"}order=block_number.asc,log_index.asc`;
  const response = await send(fetchFn, `${store.url}/rest/v1/market_events?${query}`, {
    method: "GET",
    headers: headers(store),
  });
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || !rows.every(isStoredEvent)) {
    throw new StoreRowMalformed("market_events rows are malformed");
  }
  return rows;
}
