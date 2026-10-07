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

export type NextStep =
  "settle" | "finalize-then-settle" | "cancel" | "stop-renewing" | "wait" | "none";

// What a holder can do next with an order, from its state and its series'. `now` is the chain's time.
// While a week runs, cancelling an attached order is how it stops renewing: settling would renew it,
// and the next batch freezes it until it's written again.
export function nextStep(order: OrderState, series: SeriesState | null, now: bigint): NextStep {
  if (order.series !== 0n && series !== null) {
    if (series.settled) return "settle";
    if (now >= series.windowEnd) return "finalize-then-settle";
    return order.status === "active" && !order.frozen ? "stop-renewing" : "wait";
  }
  if (order.status === "active") return order.frozen ? "wait" : "cancel";
  return "none";
}

// The decoded revert inside a viem error, found by name so it works across copies of viem.
function revertOf(
  error: unknown,
): { readonly errorName?: string; readonly args?: readonly unknown[] } | null {
  for (
    let e: unknown = error;
    typeof e === "object" && e !== null;
    e = (e as { cause?: unknown }).cause
  ) {
    if ((e as { name?: unknown }).name === "ContractFunctionRevertedError") {
      return (e as { data?: { errorName?: string; args?: readonly unknown[] } }).data ?? null;
    }
  }
  return null;
}

// When finalizing `series` would revert because its window is still open, the end the market
// reports; null when finalize would go through. The windowEnd view only counts quiet time that's
// been recorded, and finalize records it first, so finalize can find a window open after the view
// says it closed. While the chain stays quiet the reported end keeps moving, up to the extension
// cap. Any other failure is thrown.
export async function finalizeBlockedUntil(
  client: PublicClient,
  market: Address,
  account: Address,
  series: bigint,
): Promise<bigint | null> {
  try {
    await client.simulateContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "finalize",
      args: [series],
      account,
    });
    return null;
  } catch (error) {
    const revert = revertOf(error);
    const end = revert?.errorName === "WindowStillOpen" ? revert.args?.[1] : undefined;
    if (typeof end === "bigint") return end;
    throw error;
  }
}
