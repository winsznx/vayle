import { useEffect, useState } from "react";

// Order history comes from the indexer's API. Without it the app still works, and history is
// simply not shown.

export interface OrderHistory {
  readonly state: "active" | "cancelled" | "closed";
  readonly premiumEarned: bigint;
  readonly weeksFilled: number;
  readonly skipStreak: number;
  readonly toBlock: string | null;
}

interface Payload {
  readonly order?: {
    readonly state?: unknown;
    readonly premiumEarned?: unknown;
    readonly weeksFilled?: unknown;
    readonly skipStreak?: unknown;
  };
  readonly source?: { readonly toBlock?: unknown };
}

function parse(payload: Payload): OrderHistory | null {
  const o = payload.order;
  if (o === undefined) return null;
  const { state, premiumEarned, weeksFilled, skipStreak } = o;
  if (state !== "active" && state !== "cancelled" && state !== "closed") return null;
  if (typeof premiumEarned !== "string" || !/^\d+$/.test(premiumEarned)) return null;
  if (typeof weeksFilled !== "number" || typeof skipStreak !== "number") return null;
  const toBlock = payload.source?.toBlock;
  return {
    state,
    premiumEarned: BigInt(premiumEarned),
    weeksFilled,
    skipStreak,
    toBlock: typeof toBlock === "string" ? toBlock : null,
  };
}

export function useHistory(
  indexerUrl: string | null,
  ids: readonly bigint[],
): ReadonlyMap<bigint, OrderHistory> {
  const [history, setHistory] = useState<ReadonlyMap<bigint, OrderHistory>>(new Map());
  const key = ids.join(",");
  useEffect(() => {
    if (indexerUrl === null || key === "") return;
    const controller = new AbortController();
    const wanted = key.split(",").map((id) => BigInt(id));
    Promise.all(
      wanted.map(async (id) => {
        const response = await fetch(`${indexerUrl}/v1/orders/${id.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const parsed = parse((await response.json()) as Payload);
        return parsed === null ? null : ([id, parsed] as const);
      }),
    ).then(
      (entries) => {
        setHistory(
          new Map(entries.filter((e): e is readonly [bigint, OrderHistory] => e !== null)),
        );
      },
      (error: unknown) => {
        // An aborted request means the component moved on, and any other failure just hides history.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.warn("order history unavailable", error);
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [indexerUrl, key]);
  return history;
}
