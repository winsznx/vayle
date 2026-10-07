import { vayleMarketAbi } from "@vayle/abi";
import { erc20Abi, type Address, type ContractFunctionReturnType, type PublicClient } from "viem";

// What a holder needs to see, read straight from the market's views. No logs, so any RPC works.
// Every read takes an optional block number, so a page of reads can't mix two states of the market.

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

type OrderView = ContractFunctionReturnType<typeof vayleMarketAbi, "view", "orderOf">;

// On a client whose chain names Multicall3 and that batches reads, reads started together go out as
// one Multicall3 call per few hundred, so they all start at once. Any other client, a wallet's
// provider for one, gets plain eth_calls READ_BATCH at a time.
const READ_BATCH = 20;

function batchesReads(client: PublicClient): boolean {
  return Boolean(client.batch?.multicall) && client.chain?.contracts?.multicall3 !== undefined;
}

async function readAll<T, R>(
  client: PublicClient,
  items: readonly T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  if (batchesReads(client)) return Promise.all(items.map(read));
  const results: R[] = [];
  for (let i = 0; i < items.length; i += READ_BATCH) {
    results.push(...(await Promise.all(items.slice(i, i + READ_BATCH).map(read))));
  }
  return results;
}

function at(blockNumber: bigint | undefined): { blockNumber?: bigint } {
  return blockNumber === undefined ? {} : { blockNumber };
}

function toOrderState(id: bigint, o: OrderView, frozen: boolean): OrderState {
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

export async function orderState(
  client: PublicClient,
  market: Address,
  id: bigint,
  blockNumber?: bigint,
): Promise<OrderState> {
  const [o, frozen] = await Promise.all([
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "orderOf",
      args: [id],
      ...at(blockNumber),
    }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "frozen",
      args: [id],
      ...at(blockNumber),
    }),
  ]);
  return toOrderState(id, o, frozen);
}

// Every order an address placed, found by reading every order once. It needs no indexer and no
// log history, and on a batching client a few hundred orders cost one call. The indexer answers the
// same question without reading the whole book.
export async function ordersOf(
  client: PublicClient,
  market: Address,
  owner: Address,
  blockNumber?: bigint,
): Promise<OrderState[]> {
  const count = await client.readContract({
    address: market,
    abi: vayleMarketAbi,
    functionName: "orderCount",
    ...at(blockNumber),
  });
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const orders = await readAll(client, ids, async (id) => ({
    id,
    order: await client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "orderOf",
      args: [id],
      ...at(blockNumber),
    }),
  }));
  const mine = orders.filter(({ order }) => order.owner.toLowerCase() === owner.toLowerCase());
  return readAll(client, mine, async ({ id, order }) =>
    toOrderState(
      id,
      order,
      await client.readContract({
        address: market,
        abi: vayleMarketAbi,
        functionName: "frozen",
        args: [id],
        ...at(blockNumber),
      }),
    ),
  );
}

export async function seriesState(
  client: PublicClient,
  market: Address,
  id: bigint,
  blockNumber?: bigint,
): Promise<SeriesState> {
  const [key, windowEnd, pool] = await Promise.all([
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "seriesKey",
      args: [id],
      ...at(blockNumber),
    }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "windowEnd",
      args: [id],
      ...at(blockNumber),
    }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "poolOf",
      args: [id],
      ...at(blockNumber),
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
  blockNumber?: bigint,
): Promise<bigint> {
  return client.readContract({
    address: market,
    abi: vayleMarketAbi,
    functionName: "claimable",
    args: [owner, token],
    ...at(blockNumber),
  });
}

export async function balanceOf(
  client: PublicClient,
  token: Address,
  owner: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
    ...at(blockNumber),
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
