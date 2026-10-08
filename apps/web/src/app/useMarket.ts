import { vayleMarketAbi } from "@vayle/abi";
import {
  balanceOf,
  CALL,
  claimable,
  finalizeBlockedUntil,
  ordersOf,
  PUT,
  seriesId,
  seriesState,
  type OrderState,
  type SeriesState,
} from "@vayle/market";
import type { Market } from "@vayle/markets";
import { useEffect, useState } from "react";
import { erc20Abi, parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import type { AppConfig } from "./config.ts";
import { shortError } from "./failures.ts";
import { ladder, type Epoch } from "./week.ts";

// What one side of a market may take, in raw token units. A buy target counts the tokens it would
// buy.
export interface Caps {
  readonly openSize: bigint;
  readonly walletSize: bigint;
  readonly seriesOpenInterest: bigint;
  readonly fillSize: bigint;
}

export interface BySide<T> {
  readonly sell: T;
  readonly buy: T;
}

// One listed market as the chain reports it.
export interface AssetView {
  readonly market: Market;
  readonly epoch: Epoch | null;
  readonly feedAnswer: bigint;
  readonly feedDecimals: number;
  // This week's batch best bid per listed strike, in USDG base units per raw token.
  readonly bids: ReadonlyMap<bigint, bigint>;
  // New targets are paused on this market alone.
  readonly paused: boolean;
  readonly caps: BySide<Caps>;
  // The size of every active target on this market, per side.
  readonly open: BySide<bigint>;
}

export interface Holding {
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly claimable: bigint;
}

export interface TokenAccount extends Holding {
  // The size of this wallet's active targets on the market, per side, which the per-wallet cap
  // counts.
  readonly walletOpen: BySide<bigint>;
}

export interface AccountView {
  // Every target the wallet set, on every market.
  readonly orders: readonly OrderState[];
  readonly series: ReadonlyMap<bigint, SeriesState>;
  // Series whose window the view says is over but that finalize would still find open, with the
  // end it reports. The chain has been quiet, and quiet time extends windows.
  readonly heldOpen: ReadonlyMap<bigint, bigint>;
  readonly usdg: Holding;
  // Each listed market's token, by its address.
  readonly tokens: ReadonlyMap<Address, TokenAccount>;
}

export interface MarketView {
  readonly block: bigint;
  readonly now: number;
  // New targets are paused on every market.
  readonly paused: boolean;
  // When the latest emergency halt ends, in seconds, or 0 when there's never been one.
  readonly haltedUntil: number;
  // Every listed market, in the build's order.
  readonly assets: readonly AssetView[];
  readonly account: AccountView | null;
}

export function assetOf(view: MarketView, token: Address): AssetView | undefined {
  return view.assets.find((a) => a.market.token === token);
}

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const POLL_MS = 15_000;

// Every read in a poll is pinned to the block the poll starts from, so the page never shows one
// block's targets beside another block's series. Reads that don't wait on each other start
// together, and the client sends each such group as one Multicall3 call. Every market's reads start
// in the same groups, so more markets add reads to the calls a poll makes, not calls.

interface Head {
  readonly number: bigint;
  readonly timestamp: bigint;
}

async function readEpoch(
  client: PublicClient,
  config: AppConfig,
  market: Market,
  blockNumber: bigint,
): Promise<Epoch | null> {
  const at = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const expiry = await client.readContract({
    ...at,
    functionName: "latestExpiry",
    args: [market.token],
  });
  if (expiry === 0n) return null;
  const e = await client.readContract({
    ...at,
    functionName: "epoch",
    args: [market.token, expiry],
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
  market: Market,
  epoch: Epoch,
  blockNumber: bigint,
): Promise<Map<bigint, bigint>> {
  const bids = new Map<bigint, bigint>();
  await Promise.all(
    ladder(epoch).map(async (rung) => {
      const side = rung.side === "sell" ? CALL : PUT;
      const series = seriesId({
        chainId: BigInt(config.chainId),
        asset: market.token,
        side,
        strike: rung.strike,
        expiry: BigInt(epoch.expiry),
        windowLength: epoch.windowLength,
        collateralToken: side === CALL ? market.token : config.usdg,
      });
      const bid = await client.readContract({
        address: config.market,
        abi: vayleMarketAbi,
        functionName: "bestBid",
        args: [series],
        blockNumber,
      });
      if (bid.maker !== zeroAddress) bids.set(rung.strike, bid.premium);
    }),
  );
  return bids;
}

async function readAsset(
  client: PublicClient,
  config: AppConfig,
  market: Market,
  blockNumber: bigint,
): Promise<AssetView> {
  const at = { address: config.market, abi: vayleMarketAbi, blockNumber } as const;
  const feed = { address: market.feed, abi: feedAbi, blockNumber } as const;
  const [week, round, feedDecimals, paused, sellCaps, buyCaps, openSell, openBuy] =
    await Promise.all([
      readEpoch(client, config, market, blockNumber).then(async (epoch) => ({
        epoch,
        bids:
          epoch === null
            ? new Map<bigint, bigint>()
            : await readBids(client, config, market, epoch, blockNumber),
      })),
      client.readContract({ ...feed, functionName: "latestRoundData" }),
      client.readContract({ ...feed, functionName: "decimals" }),
      client.readContract({ ...at, functionName: "assetPaused", args: [market.token] }),
      client.readContract({ ...at, functionName: "capsOf", args: [market.token, CALL] }),
      client.readContract({ ...at, functionName: "capsOf", args: [market.token, PUT] }),
      client.readContract({ ...at, functionName: "openSize", args: [market.token, CALL] }),
      client.readContract({ ...at, functionName: "openSize", args: [market.token, PUT] }),
    ]);
  return {
    market,
    epoch: week.epoch,
    feedAnswer: round[1],
    feedDecimals,
    bids: week.bids,
    paused,
    caps: { sell: sellCaps, buy: buyCaps },
    open: { sell: openSell, buy: openBuy },
  };
}

async function readHolding(
  client: PublicClient,
  config: AppConfig,
  owner: Address,
  token: Address,
  blockNumber: bigint,
): Promise<Holding> {
  const [balance, allowance, owed] = await Promise.all([
    balanceOf(client, token, owner, blockNumber),
    client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, config.market],
      blockNumber,
    }),
    claimable(client, config.market, owner, token, blockNumber),
  ]);
  return { balance, allowance, claimable: owed };
}

async function readTokenAccount(
  client: PublicClient,
  config: AppConfig,
  owner: Address,
  market: Market,
  blockNumber: bigint,
): Promise<TokenAccount> {
  const wallet = (side: typeof CALL | typeof PUT): Promise<bigint> =>
    client.readContract({
      address: config.market,
      abi: vayleMarketAbi,
      functionName: "walletSize",
      args: [owner, market.token, side],
      blockNumber,
    });
  const [holding, sell, buy] = await Promise.all([
    readHolding(client, config, owner, market.token, blockNumber),
    wallet(CALL),
    wallet(PUT),
  ]);
  return { ...holding, walletOpen: { sell, buy } };
}

async function readAccount(
  client: PublicClient,
  config: AppConfig,
  owner: Address,
  head: Head,
): Promise<AccountView> {
  const [orders, usdg, tokens] = await Promise.all([
    ordersOf(client, config.market, owner, head.number),
    readHolding(client, config, owner, config.usdg, head.number),
    Promise.all(
      config.markets.map(
        async (m) =>
          [m.token, await readTokenAccount(client, config, owner, m, head.number)] as const,
      ),
    ),
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
  return { orders, series, heldOpen, usdg, tokens: new Map(tokens) };
}

async function readMarket(
  client: PublicClient,
  config: AppConfig,
  owner: Address | null,
): Promise<MarketView> {
  const head = await client.getBlock({ blockTag: "latest" });
  const at = { address: config.market, abi: vayleMarketAbi, blockNumber: head.number } as const;
  const [assets, paused, haltedUntil, account] = await Promise.all([
    Promise.all(config.markets.map((m) => readAsset(client, config, m, head.number))),
    client.readContract({ ...at, functionName: "paused" }),
    client.readContract({ ...at, functionName: "haltedUntil" }),
    owner === null ? Promise.resolve(null) : readAccount(client, config, owner, head),
  ]);
  return {
    block: head.number,
    now: Number(head.timestamp),
    paused,
    haltedUntil: Number(haltedUntil),
    assets,
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
