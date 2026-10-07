import { vayleMarketAbi } from "@vayle/abi";
import { erc20Abi, type Address, type PublicClient } from "viem";

// What a holder needs to see, read straight from the market's views. No logs, so any RPC works.

export type OrderStatus = "none" | "active" | "cancelled" | "closed";
const STATUS: readonly OrderStatus[] = ["none", "active", "cancelled", "closed"];

export interface OrderState {
  readonly id: bigint;
  readonly owner: Address;
  readonly asset: Address;
  readonly side: number;
  readonly status: OrderStatus;
  readonly target: bigint;
  readonly minPremium: bigint;
  readonly flip: boolean;
  readonly flipTarget: bigint;
  readonly size: bigint;
  readonly committed: bigint;
  readonly series: bigint;
  readonly frozen: boolean;
}

export interface SeriesState {
  readonly id: bigint;
  readonly side: number;
  readonly strike: bigint;
  readonly expiry: bigint;
  readonly windowEnd: bigint;
  readonly settled: boolean;
}

const READ_BATCH = 20;

async function inBatches<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(read))));
  }
  return results;
}

export async function orderState(
  client: PublicClient,
  market: Address,
  id: bigint,
): Promise<OrderState> {
  const [o, frozen] = await Promise.all([
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "orderOf",
      args: [id],
    }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "frozen",
      args: [id],
    }),
  ]);
  return {
    id,
    owner: o.owner,
    asset: o.asset,
    side: o.side,
    status: STATUS[o.status] ?? "none",
    target: o.target,
    minPremium: o.minPremium,
    flip: o.flip,
    flipTarget: o.flipTarget,
    size: o.size,
    committed: o.committed,
    series: o.series,
    frozen,
  };
}

// Every order an address placed, found by reading each order. Fine at pilot scale, and it needs no
// indexer and no log history from the RPC.
export async function ordersOf(
  client: PublicClient,
  market: Address,
  owner: Address,
): Promise<OrderState[]> {
  const count = await client.readContract({
    address: market,
    abi: vayleMarketAbi,
    functionName: "orderCount",
  });
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const owners = await inBatches(ids, async (id) => {
    const o = await client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "orderOf",
      args: [id],
    });
    return { id, owner: o.owner };
  });
  const mine = owners.filter((o) => o.owner.toLowerCase() === owner.toLowerCase()).map((o) => o.id);
  return inBatches(mine, (id) => orderState(client, market, id));
}

export async function seriesState(
  client: PublicClient,
  market: Address,
  id: bigint,
): Promise<SeriesState> {
  const [key, windowEnd, pool] = await Promise.all([
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "seriesKey",
      args: [id],
    }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "windowEnd",
      args: [id],
    }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "poolOf",
      args: [id],
    }),
  ]);
  return {
    id,
    side: key.optionType,
    strike: key.strike,
    expiry: key.expiry,
    windowEnd,
    settled: pool.settled,
  };
}

export async function claimable(
  client: PublicClient,
  market: Address,
  owner: Address,
  token: Address,
): Promise<bigint> {
  return client.readContract({
    address: market,
    abi: vayleMarketAbi,
    functionName: "claimable",
    args: [owner, token],
  });
}

export async function balanceOf(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export type NextStep = "settle" | "finalize-then-settle" | "cancel" | "wait" | "none";

// What a holder can do next with an order, from its state and its series'. `now` is the chain's time.
export function nextStep(order: OrderState, series: SeriesState | null, now: bigint): NextStep {
  if (order.series !== 0n && series !== null) {
    if (series.settled) return "settle";
    if (now >= series.windowEnd) return "finalize-then-settle";
    return "wait";
  }
  if (order.status === "active") return order.frozen ? "wait" : "cancel";
  return "none";
}
