import { vayleMarketAbi } from "@vayle/abi";
import {
  balanceOf,
  claimable,
  finalizeBlockedUntil,
  ordersOf,
  seriesId,
  seriesState,
  type OrderState,
  type SeriesState,
} from "@vayle/market";
import { useEffect, useState } from "react";
import { erc20Abi, parseAbi, type Address, type PublicClient } from "viem";
import type { AppConfig } from "./config.ts";
import { shortError } from "./failures.ts";
import { ladder, type Epoch } from "./week.ts";

export interface AccountView {
  readonly orders: readonly OrderState[];
  readonly series: ReadonlyMap<bigint, SeriesState>;
  // Series whose window the view says is over but that finalize would still find open, with the
  // end it reports. The chain has been quiet, and quiet time extends windows.
  readonly heldOpen: ReadonlyMap<bigint, bigint>;
  readonly claimableAsset: bigint;
  readonly claimableUsdg: bigint;
  readonly balanceAsset: bigint;
  readonly balanceUsdg: bigint;
  readonly allowanceAsset: bigint;
  readonly allowanceUsdg: bigint;
}

export interface MarketView {
  readonly block: bigint;
  readonly now: number;
  readonly epoch: Epoch | null;
  readonly feedAnswer: bigint;
  readonly feedDecimals: number;
  // This week's best bid per listed strike, in USDG base units per raw token.
  readonly bids: ReadonlyMap<bigint, bigint>;
  readonly account: AccountView | null;
}

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const POLL_MS = 15_000;
const NO_MAKER = "0x0000000000000000000000000000000000000000";

// Every read in a poll is pinned to the block the poll starts from, so the page never shows one
// block's orders beside another block's series. Reads that don't wait on each other start together,
// and the client sends each such group as one Multicall3 call.

interface Head {
  readonly number: bigint;
  readonly timestamp: bigint;
}

async function readEpoch(
  client: PublicClient,
  config: AppConfig,
  blockNumber: bigint,
): Promise<Epoch | null> {
  const market = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const expiry = await client.readContract({
    ...market,
    functionName: "latestExpiry",
    args: [config.asset],
  });
  if (expiry === 0n) return null;
  const e = await client.readContract({
    ...market,
    functionName: "epoch",
    args: [config.asset, expiry],
  });
  return {
    opening: Number(e.opening),
    expiry: Number(e.expiry),
    batchDeadline: Number(e.batchDeadline),
    windowLength: e.windowLength,
    referencePrice: e.referencePrice,
    strikeTick: e.strikeTick,
    strikeRangeBps: e.strikeRangeBps,
    priceTick: e.priceTick,
    lot: e.lot,
    rawUnit: e.rawUnit,
  };
}

async function readBids(
  client: PublicClient,
  config: AppConfig,
  epoch: Epoch,
  blockNumber: bigint,
): Promise<Map<bigint, bigint>> {
  const bids = new Map<bigint, bigint>();
  await Promise.all(
    ladder(epoch).map(async (rung) => {
      const side = rung.side === "sell" ? 0 : 1;
      const series = seriesId({
        chainId: BigInt(config.chainId),
        asset: config.asset,
        side,
        strike: rung.strike,
        expiry: BigInt(epoch.expiry),
        windowLength: epoch.windowLength,
        collateralToken: side === 0 ? config.asset : config.usdg,
      });
      const bid = await client.readContract({
        address: config.market,
        abi: vayleMarketAbi,
        functionName: "bestBid",
        args: [series],
        blockNumber,
      });
      if (bid.maker !== NO_MAKER) bids.set(rung.strike, bid.premium);
    }),
  );
  return bids;
}

async function readAccount(
  client: PublicClient,
  config: AppConfig,
  owner: Address,
  head: Head,
): Promise<AccountView> {
  const allowance = (token: Address): Promise<bigint> =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, config.market],
      blockNumber: head.number,
    });
  const [
    orders,
    claimableAsset,
    claimableUsdg,
    balanceAsset,
    balanceUsdg,
    allowanceAsset,
    allowanceUsdg,
  ] = await Promise.all([
    ordersOf(client, config.market, owner, head.number),
    claimable(client, config.market, owner, config.asset, head.number),
    claimable(client, config.market, owner, config.usdg, head.number),
    balanceOf(client, config.asset, owner, head.number),
    balanceOf(client, config.usdg, owner, head.number),
    allowance(config.asset),
    allowance(config.usdg),
  ]);
  const ids = [...new Set(orders.filter((o) => o.series !== 0n).map((o) => o.series))];
  const series = new Map(
    await Promise.all(
      ids.map(
        async (id) => [id, await seriesState(client, config.market, id, head.number)] as const,
      ),
    ),
  );
  // Finalizing is simulated at the chain's head rather than the pinned block, since the question is
  // whether it would go through if sent now.
  const due = [...series.values()].filter((s) => !s.settled && head.timestamp >= s.windowEnd);
  const blocked = await Promise.all(
    due.map(
      async (s) => [s.id, await finalizeBlockedUntil(client, config.market, owner, s.id)] as const,
    ),
  );
  const heldOpen = new Map<bigint, bigint>();
  for (const [id, until] of blocked) if (until !== null) heldOpen.set(id, until);
  return {
    orders,
    series,
    heldOpen,
    claimableAsset,
    claimableUsdg,
    balanceAsset,
    balanceUsdg,
    allowanceAsset,
    allowanceUsdg,
  };
}

async function readMarket(
  client: PublicClient,
  config: AppConfig,
  owner: Address | null,
): Promise<MarketView> {
  const head = await client.getBlock({ blockTag: "latest" });
  const at = { blockNumber: head.number } as const;
  const [week, round, feedDecimals, account] = await Promise.all([
    readEpoch(client, config, head.number).then(async (epoch) => ({
      epoch,
      bids:
        epoch === null
          ? new Map<bigint, bigint>()
          : await readBids(client, config, epoch, head.number),
    })),
    client.readContract({
      address: config.feed,
      abi: feedAbi,
      functionName: "latestRoundData",
      ...at,
    }),
    client.readContract({ address: config.feed, abi: feedAbi, functionName: "decimals", ...at }),
    owner === null ? Promise.resolve(null) : readAccount(client, config, owner, head),
  ]);
  return {
    block: head.number,
    now: Number(head.timestamp),
    epoch: week.epoch,
    feedAnswer: round[1],
    feedDecimals,
    bids: week.bids,
    account,
  };
}

export interface MarketState {
  readonly view: MarketView | null;
  readonly error: string | null;
}

// The chain is the external system here: read it now, every 15 seconds while the page is in view,
// on coming back to the page, and whenever `version` changes, which the app bumps after a
// transaction confirms. A hidden tab doesn't poll, and only one read runs at a time.
export function useMarket(
  client: PublicClient,
  config: AppConfig,
  owner: Address | null,
  version: number,
): MarketState {
  const [state, setState] = useState<MarketState>({ view: null, error: null });
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const load = (): void => {
      if (running || document.hidden) return;
      running = true;
      readMarket(client, config, owner)
        .then(
          (view) => {
            if (!cancelled) setState({ view, error: null });
          },
          (error: unknown) => {
            if (cancelled) return;
            setState((previous) => ({ view: previous.view, error: shortError(error) }));
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
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, config, owner, version]);
  return state;
}
