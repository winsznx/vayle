import { orderSummary, seriesExpiries, weeksOf, type MarketEvent } from "@vayle/market";
import { isAddress } from "viem";

export interface Source {
  readonly chainId: number;
  readonly market: string;
  // The last block indexed. Data after it isn't in the response yet.
  readonly toBlock: string | null;
}

export interface ApiDeps {
  readonly select: (filter: string) => Promise<MarketEvent[]>;
  readonly source: () => Promise<Source>;
  readonly now: () => number;
}

export const RUN_PAGE = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=5",
    },
  });
}

const DECIMAL = /^[0-9]{1,78}$/;

async function ownerOrders(address: string, deps: ApiDeps): Promise<Response> {
  if (!isAddress(address)) return json({ error: "not an address" }, 400);
  const placed = await deps.select(`name=eq.OrderPlaced&account=eq.${address.toLowerCase()}`);
  const ids = placed.flatMap((e) => (e.order_id === null ? [] : [e.order_id]));
  return json({ orders: ids, source: await deps.source() });
}

// Everything an owner did and everything that happened to their orders: placements, credits and
// withdrawals filed under their address, and every event of the orders they placed.
async function ownerEvents(address: string, deps: ApiDeps): Promise<Response> {
  if (!isAddress(address)) return json({ error: "not an address" }, 400);
  const own = await deps.select(`account=eq.${address.toLowerCase()}`);
  const ids = [
    ...new Set(
      own.flatMap((e) => (e.name === "OrderPlaced" && e.order_id !== null ? [e.order_id] : [])),
    ),
  ];
  const ofOrders = ids.length === 0 ? [] : await deps.select(`order_id=in.(${ids.join(",")})`);
  const byPosition = new Map<string, MarketEvent>();
  for (const e of [...own, ...ofOrders]) byPosition.set(`${e.block_number}:${e.log_index}`, e);
  const events = [...byPosition.values()].sort(
    (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
  );
  return json({ events, source: await deps.source() });
}

async function order(id: string, deps: ApiDeps): Promise<Response> {
  if (!DECIMAL.test(id)) return json({ error: "not an order ID" }, 400);
  const events = await deps.select(
    `or=(order_id.eq.${id},and(name.eq.OrderFlipped,args->>toId.eq.${id}))`,
  );
  if (events.length === 0) return json({ error: "no such order" }, 404);
  const placed = events.find((e) => e.name === "OrderPlaced" && e.order_id === id);
  const asset = typeof placed?.args["asset"] === "string" ? placed.args["asset"] : "";
  const series = [...new Set(events.flatMap((e) => (e.series === null ? [] : [e.series])))];
  const [epochs, registered] = await Promise.all([
    deps.select("name=eq.EpochCreated"),
    series.length === 0
      ? Promise.resolve([])
      : deps.select(`name=eq.SeriesRegistered&series=in.(${series.join(",")})`),
  ]);
  return json({
    order: orderSummary(id, events, weeksOf(epochs, asset), seriesExpiries(registered), deps.now()),
    events,
    source: await deps.source(),
  });
}

// A place in the public record. Without a log index it's the end of the whole block, which is what
// `after=<block>` has always meant.
interface Cursor {
  readonly block: bigint;
  readonly logIndex: bigint | null;
}

const CURSOR = /^([0-9]{1,78})(?::([0-9]{1,78}))?$/;
// block_number is a Postgres bigint and log_index an integer. PostgREST answers a value past them
// with an error, not an empty page.
const MAX_BLOCK = 2n ** 63n - 1n;
const MAX_LOG_INDEX = 2n ** 31n - 1n;

function readCursor(after: string): Cursor | { readonly error: string } {
  const [, blockDigits, logIndexDigits] = CURSOR.exec(after) ?? [];
  if (blockDigits === undefined) return { error: "after must be <block> or <block>:<logIndex>" };
  const block = BigInt(blockDigits);
  if (block > MAX_BLOCK) return { error: "after's block number is too large" };
  if (logIndexDigits === undefined) return { block, logIndex: null };
  const logIndex = BigInt(logIndexDigits);
  if (logIndex > MAX_LOG_INDEX) return { error: "after's log index is too large" };
  return { block, logIndex };
}

function cursorText(cursor: Cursor): string {
  const block = cursor.block.toString();
  return cursor.logIndex === null ? block : `${block}:${cursor.logIndex.toString()}`;
}

// PostgREST has no row comparison, so (block_number, log_index) > (block, logIndex) is spelled out.
// The plain block_number >= block beside it lets Postgres start its primary key scan at that block
// instead of at the first event.
function afterFilter(cursor: Cursor): string {
  const block = cursor.block.toString();
  if (cursor.logIndex === null) return `block_number=gt.${block}`;
  const restOfBlock = `and(block_number.eq.${block},log_index.gt.${cursor.logIndex.toString()})`;
  return `block_number=gte.${block}&or=(block_number.gt.${block},${restOfBlock})`;
}

async function run(params: URLSearchParams, deps: ApiDeps): Promise<Response> {
  const cursor = readCursor(params.get("after") ?? "0");
  if ("error" in cursor) return json({ error: cursor.error }, 400);
  // The indexer saves its cursor only after the rows up to it, so with the tip read first, every
  // event up to source.toBlock is already in the table this page comes from.
  const source = await deps.source();
  const events = await deps.select(`${afterFilter(cursor)}&limit=${RUN_PAGE}`);
  // Taken from the rows that came back, never from the page size, so a store that returns fewer
  // can't make a client skip any.
  const last = events.at(-1);
  const next = last === undefined ? cursorText(cursor) : `${last.block_number}:${last.log_index}`;
  return json({ events, next, source });
}

export async function handle(request: Request, deps: ApiDeps): Promise<Response> {
  if (request.method !== "GET") return json({ error: "read-only" }, 405);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter((p) => p !== "");
  if (parts[0] !== "v1") return json({ error: "not found" }, 404);
  if (
    parts[1] === "owners" &&
    parts[2] !== undefined &&
    parts[3] === "orders" &&
    parts.length === 4
  ) {
    return ownerOrders(parts[2], deps);
  }
  if (
    parts[1] === "owners" &&
    parts[2] !== undefined &&
    parts[3] === "events" &&
    parts.length === 4
  ) {
    return ownerEvents(parts[2], deps);
  }
  if (parts[1] === "orders" && parts[2] !== undefined && parts.length === 3)
    return order(parts[2], deps);
  if (parts[1] === "run" && parts.length === 2) return run(url.searchParams, deps);
  return json({ error: "not found" }, 404);
}
