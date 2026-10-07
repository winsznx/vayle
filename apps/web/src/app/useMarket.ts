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

async function readEpoch(client: PublicClient, config: AppConfig): Promise<Epoch | null> {
  const market = { address: config.market, abi: vayleMarketAbi } as const;
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
  now: bigint,
): Promise<AccountView> {
  const orders = await ordersOf(client, config.market, owner);
  const ids = [...new Set(orders.filter((o) => o.series !== 0n).map((o) => o.series))];
  const series = new Map(
    await Promise.all(
      ids.map(async (id) => [id, await seriesState(client, config.market, id)] as const),
    ),
  );
  const due = [...series.values()].filter((s) => !s.settled && now >= s.windowEnd);
  const heldOpen = new Map<bigint, bigint>();
  for (const s of due) {
    const until = await finalizeBlockedUntil(client, config.market, owner, s.id);
    if (until !== null) heldOpen.set(s.id, until);
  }
  const allowance = (token: Address): Promise<bigint> =>
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, config.market],
    });
  const [claimableAsset, claimableUsdg, balanceAsset, balanceUsdg, allowanceAsset, allowanceUsdg] =
    await Promise.all([
      claimable(client, config.market, owner, config.asset),
      claimable(client, config.market, owner, config.usdg),
      balanceOf(client, config.asset, owner),
      balanceOf(client, config.usdg, owner),
      allowance(config.asset),
      allowance(config.usdg),
    ]);
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
  const [block, epoch, round, feedDecimals] = await Promise.all([
    client.getBlock({ blockTag: "latest" }),
    readEpoch(client, config),
    client.readContract({ address: config.feed, abi: feedAbi, functionName: "latestRoundData" }),
    client.readContract({ address: config.feed, abi: feedAbi, functionName: "decimals" }),
  ]);
  const [bids, account] = await Promise.all([
    epoch === null ? Promise.resolve(new Map<bigint, bigint>()) : readBids(client, config, epoch),
    owner === null ? Promise.resolve(null) : readAccount(client, config, owner, block.timestamp),
  ]);
  return {
    block: block.number,
    now: Number(block.timestamp),
    epoch,
    feedAnswer: round[1],
    feedDecimals,
    bids,
    account,
  };
}

export interface MarketState {
  readonly view: MarketView | null;
  readonly error: string | null;
}

// The chain is the external system here: read it now and every 15 seconds, and again whenever
// `version` changes, which the app bumps after a transaction confirms.
export function useMarket(
  client: PublicClient,
  config: AppConfig,
  owner: Address | null,
  version: number,
): MarketState {
  const [state, setState] = useState<MarketState>({ view: null, error: null });
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      readMarket(client, config, owner).then(
        (view) => {
          if (!cancelled) setState({ view, error: null });
        },
        (error: unknown) => {
          if (cancelled) return;
          setState((previous) => ({ view: previous.view, error: shortError(error) }));
        },
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, config, owner, version]);
  return state;
}
