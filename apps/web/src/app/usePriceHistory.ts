import { useEffect, useState } from "react";
import { parseAbi, type Address, type PublicClient } from "viem";
import { shortError } from "./failures.ts";

// The feed's recent rounds, for the price chart. A round is an answer the feed posted and held
// until the next one. The feed posts about seven a trading day, so a month is a couple of hundred,
// read in one batched call.

export interface PricePoint {
  // When the round landed, in seconds.
  readonly time: number;
  // USDG per raw token at the feed's decimals.
  readonly answer: bigint;
}

export type PriceHistory =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      // Oldest first, the latest round last.
      readonly points: readonly PricePoint[];
      readonly decimals: number;
    }
  | { readonly status: "failed"; readonly reason: string };

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);

export const PRICE_SPAN = 30 * 86_400;
const MAX_ROUNDS = 240n;
const REFRESH_MS = 5 * 60_000;
// A round ID carries the feed's phase in its top bits. Within a phase, rounds count up from 1.
const PHASE_SHIFT = 64n;
const ROUND_MASK = (1n << PHASE_SHIFT) - 1n;

async function readPrices(
  client: PublicClient,
  feed: Address,
): Promise<{ points: PricePoint[]; decimals: number }> {
  const [[roundId, answer, , updatedAt], decimals] = await Promise.all([
    client.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" }),
    client.readContract({ address: feed, abi: feedAbi, functionName: "decimals" }),
  ]);
  const phase = roundId >> PHASE_SHIFT;
  const latest = roundId & ROUND_MASK;
  const ids: bigint[] = [];
  for (let back = 1n; back < MAX_ROUNDS && latest - back >= 1n; back++) {
    ids.push((phase << PHASE_SHIFT) | (latest - back));
  }
  const earlier = await Promise.all(
    ids.map((id) =>
      client.readContract({
        address: feed,
        abi: feedAbi,
        functionName: "getRoundData",
        args: [id],
      }),
    ),
  );
  const since = Number(updatedAt) - PRICE_SPAN;
  // A round without a positive answer isn't a price, and the market refuses one too.
  const points = [[roundId, answer, 0n, updatedAt] as const, ...earlier]
    .filter(([, value, , time]) => value > 0n && Number(time) >= since)
    .map(([, value, , time]) => ({ time: Number(time), answer: value }))
    .sort((a, b) => a.time - b.time);
  return { points, decimals };
}

// The feed is the external system: read it now, every five minutes while the page is in view, and
// on coming back to the page. A failed refresh keeps the chart that was showing.
export function usePriceHistory(client: PublicClient, feed: Address): PriceHistory {
  const [state, setState] = useState<PriceHistory>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const load = (): void => {
      if (running || document.hidden) return;
      running = true;
      readPrices(client, feed)
        .then(
          ({ points, decimals }) => {
            if (!cancelled) setState({ status: "ready", points, decimals });
          },
          (error: unknown) => {
            if (cancelled) return;
            setState((previous) =>
              previous.status === "ready"
                ? previous
                : { status: "failed", reason: shortError(error) },
            );
          },
        )
        .finally(() => {
          running = false;
        });
    };
    const onVisibility = (): void => {
      if (!document.hidden) load();
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, feed]);
  return state;
}
