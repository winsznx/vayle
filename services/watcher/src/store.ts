import type { StoreConfig } from "./config.ts";
import { StoreRequestFailed, StoreRowMalformed } from "./errors.ts";
import type { ActiveCondition, ActiveConditions, Severity } from "./rules.ts";

export interface WatcherState {
  // The last block whose logs were processed, or null before the first run.
  readonly cursor: bigint | null;
  readonly active: ActiveConditions;
  // Consecutive failed runs.
  readonly failures: number;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const TABLE = "watcher_state";
const ROW_ID = "main";
const SEVERITIES: readonly Severity[] = ["page", "warn", "info"];

export const EMPTY_STATE: WatcherState = { cursor: null, active: {}, failures: 0 };

function headers(store: StoreConfig): Record<string, string> {
  return {
    apikey: store.serviceKey,
    authorization: `Bearer ${store.serviceKey}`,
    "content-type": "application/json",
  };
}

export function loadRequest(store: StoreConfig): { url: string; init: RequestInit } {
  return {
    url: `${store.url}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=cursor_block,active,failures`,
    init: { method: "GET", headers: headers(store) },
  };
}

export function saveRequest(
  store: StoreConfig,
  state: WatcherState,
): { url: string; init: RequestInit } {
  return {
    url: `${store.url}/rest/v1/${TABLE}?on_conflict=id`,
    init: {
      method: "POST",
      headers: { ...headers(store), prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        id: ROW_ID,
        cursor_block: state.cursor === null ? null : state.cursor.toString(),
        active: state.active,
        failures: state.failures,
      }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseActive(value: unknown): ActiveConditions {
  if (!isRecord(value)) throw new StoreRowMalformed("active isn't an object");
  const active: Record<string, ActiveCondition> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !isRecord(entry) ||
      !SEVERITIES.includes(entry["severity"] as Severity) ||
      typeof entry["since"] !== "number" ||
      typeof entry["lastSent"] !== "number"
    ) {
      throw new StoreRowMalformed(`active condition ${key} is malformed`);
    }
    active[key] = {
      severity: entry["severity"] as Severity,
      since: entry["since"],
      lastSent: entry["lastSent"],
    };
  }
  return active;
}

// The stored state, or the empty state before the first run.
export function parseRows(rows: unknown): WatcherState {
  if (!Array.isArray(rows)) throw new StoreRowMalformed("expected an array of rows");
  const row: unknown = rows[0];
  if (row === undefined) return EMPTY_STATE;
  if (!isRecord(row)) throw new StoreRowMalformed("row isn't an object");
  const cursor = row["cursor_block"];
  const failures = row["failures"];
  if (!(cursor === null || typeof cursor === "string" || typeof cursor === "number")) {
    throw new StoreRowMalformed("cursor_block isn't a block number");
  }
  if (typeof failures !== "number") throw new StoreRowMalformed("failures isn't a number");
  return {
    cursor: cursor === null ? null : BigInt(cursor),
    active: parseActive(row["active"]),
    failures,
  };
}

async function send(
  fetchFn: Fetch,
  request: { url: string; init: RequestInit },
): Promise<Response> {
  const response = await fetchFn(request.url, request.init);
  if (!response.ok) {
    throw new StoreRequestFailed(
      `${request.init.method ?? "GET"} ${TABLE}: HTTP ${response.status}`,
    );
  }
  return response;
}

export async function loadState(store: StoreConfig, fetchFn: Fetch): Promise<WatcherState> {
  const response = await send(fetchFn, loadRequest(store));
  return parseRows(await response.json());
}

export async function saveState(
  store: StoreConfig,
  state: WatcherState,
  fetchFn: Fetch,
): Promise<void> {
  await send(fetchFn, saveRequest(store, state));
}
