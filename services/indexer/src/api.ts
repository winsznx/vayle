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

async function order(id: string, deps: ApiDeps): Promise<Response> {
  if (!DECIMAL.test(id)) return json({ error: "not an order ID" }, 400);
  const events = await deps.select(
    `or=(order_id.eq.${id},and(name.eq.OrderFlipped,args->>toId.eq.${id}))`,
  );
  if (events.length === 0) return json({ error: "no such order" }, 404);
  const series = [...new Set(events.flatMap((e) => (e.series === null ? [] : [e.series])))];
  const [epochs, registered] = await Promise.all([
    deps.select("name=eq.EpochCreated"),
    series.length === 0
      ? Promise.resolve([])
      : deps.select(`name=eq.SeriesRegistered&series=in.(${series.join(",")})`),
  ]);
  return json({
    order: orderSummary(id, events, weeksOf(epochs), seriesExpiries(registered), deps.now()),
    events,
    source: await deps.source(),
  });
}

async function run(params: URLSearchParams, deps: ApiDeps): Promise<Response> {
  const after = params.get("after") ?? "0";
  if (!DECIMAL.test(after)) return json({ error: "after must be a block number" }, 400);
  const events = await deps.select(`block_number=gt.${after}&limit=${RUN_PAGE}`);
  return json({ events, source: await deps.source() });
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
  if (parts[1] === "orders" && parts[2] !== undefined && parts.length === 3)
    return order(parts[2], deps);
  if (parts[1] === "run" && parts.length === 2) return run(url.searchParams, deps);
  return json({ error: "not found" }, 404);
}
