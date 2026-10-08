import type { Address, PublicClient } from "viem";
import type { MakerConfig } from "./config.ts";
import { marketPrices } from "./guard.ts";
import {
  MAX_UINT,
  freeRoom,
  premiumFor,
  quoteSize,
  quoting,
  seriesLeft,
  tradesSide,
  type MakerSnapshot,
  type Prices,
} from "./plan.ts";
import { feedSessions } from "./sessions.ts";
import { readSnapshot } from "./snapshot.ts";

// The bid sheet: what the maker would pay for each target this week lists, and how much it would
// buy, right now. It comes from the same snapshot, guard and pricing as a mid-week quote, and signs
// nothing. Amounts are decimal strings, since they pass 2^53.

export interface TargetBid {
  readonly target: string;
  // USDG base units per whole token.
  readonly premium: string;
  // The token's raw units: the most the maker would buy from one order at this target now.
  readonly maxAmount: string;
}

export interface MarketBids {
  readonly symbol: string;
  readonly token: Address;
  // When the week expires, in epoch seconds.
  readonly expiry: number;
  // The feed round the premiums were priced from.
  readonly round: { readonly id: string; readonly updatedAt: number };
  // The annualized volatility priced with, in basis points.
  readonly volBps: number;
  readonly sell: readonly TargetBid[];
  readonly buy: readonly TargetBid[];
}

export interface BidSheet {
  // The block time everything in the sheet was priced at.
  readonly computedAt: number;
  readonly source: { readonly chainId: number; readonly market: Address; readonly block: number };
  readonly markets: readonly MarketBids[];
}

const CALL = 0;
const PUT = 1;

// A market appears once it has a week and a price the guard passed. A side lists targets only while
// the maker quotes and the markets file enables the side, and a target only when the maker would buy
// some of it. Each target's size is worked out on its own: they share the maker's balances.
export function bidSheet(
  s: MakerSnapshot,
  config: Pick<MakerConfig, "chainId" | "market" | "pricing">,
  prices: Prices,
): BidSheet {
  const room = freeRoom(s);
  const markets = s.markets.flatMap((m): MarketBids[] => {
    const price = prices.get(m.market.token);
    const e = m.epoch;
    if (price?.usable !== true || e === null) return [];
    const open = quoting(s, config.pricing, e);
    const targets = (side: number): TargetBid[] =>
      !open || !tradesSide(m, side)
        ? []
        : m.buckets
            .filter((b) => b.side === side)
            .flatMap((b): TargetBid[] => {
              const premium = premiumFor(s, m, config.pricing, price, side, b.strike);
              if (premium === null) return [];
              const most = quoteSize(s, m, e, b, room, premium, MAX_UINT, seriesLeft(m, b));
              if (most === 0n) return [];
              return [
                {
                  target: b.strike.toString(),
                  premium: premium.toString(),
                  maxAmount: most.toString(),
                },
              ];
            });
    return [
      {
        symbol: m.market.symbol,
        token: m.market.token,
        expiry: e.expiry,
        round: { id: price.roundId.toString(), updatedAt: price.updatedAt },
        volBps: m.market.maker.volBps,
        sell: targets(CALL),
        buy: targets(PUT),
      },
    ];
  });
  return {
    computedAt: s.now,
    source: { chainId: config.chainId, market: config.market, block: Number(s.block) },
    markets,
  };
}

// The sheet from a fresh snapshot of every target the week lists.
export async function readBidSheet(
  config: MakerConfig,
  client: PublicClient,
  maker: Address,
): Promise<BidSheet> {
  const { snapshot } = await readSnapshot(client, config, maker, { everyTarget: true });
  const prices = marketPrices(snapshot.markets, config.usdgDecimals, feedSessions, snapshot.now);
  return bidSheet(snapshot, config, prices);
}
