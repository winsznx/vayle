import type { MarketEvent } from "@vayle/market";
import type { Market } from "@vayle/markets";
import { CASH_SYMBOL } from "../tokens.ts";
import { marketOfToken } from "./assets.ts";
import type { AppConfig } from "./config.ts";
import { amountOf, dollars, premium, unitOf, usdgAmount } from "./format.ts";

// A holder's events in their own words, for the activity list and a target's history. Credits
// aren't listed on their own: every credit comes with the fill, settlement or cancel that caused it,
// and that event already carries the amount.

export type EventKind = "earned" | "order" | "filled" | "wallet";

export interface EventLine {
  readonly kind: EventKind;
  readonly title: string;
  readonly detail: string | null;
  // What moved, from the holder's side: "+2.50 USDG" credited, "-1.00" of a token locked, and plain
  // amounts for withdrawals.
  readonly amount: string | null;
  // The ticker of the token the event is about, for its badge: the target's market, or the token a
  // withdrawal moved. Null when the build doesn't list it.
  readonly ticker: string | null;
}

// What the events themselves say about each target: its side, 0 for a sell target and 1 for a buy
// target, and the market it was set on, both from its placement.
export interface EventContext {
  readonly sideOf: (orderId: string) => 0 | 1 | null;
  readonly marketOf: (orderId: string) => Market | null;
}

export function contextOf(
  events: readonly MarketEvent[],
  markets: readonly Market[],
): EventContext {
  const sides = new Map<string, 0 | 1>();
  const placedOn = new Map<string, Market>();
  for (const e of events) {
    if (e.name !== "OrderPlaced" || e.order_id === null) continue;
    const side = e.args["side"];
    if (side === 0 || side === 1) sides.set(e.order_id, side);
    const asset = e.args["asset"];
    const market = typeof asset === "string" ? marketOfToken(markets, asset) : undefined;
    if (market !== undefined) placedOn.set(e.order_id, market);
  }
  return {
    sideOf: (orderId) => sides.get(orderId) ?? null,
    marketOf: (orderId) => placedOn.get(orderId) ?? null,
  };
}

function units(args: Readonly<Record<string, unknown>>, name: string): bigint {
  const value = args[name];
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

export function describeEvent(
  e: MarketEvent,
  config: AppConfig,
  context: EventContext,
): EventLine | null {
  const a = e.args;
  const market = e.order_id === null ? null : context.marketOf(e.order_id);
  const unit = market === null ? null : unitOf(market);
  // A token amount on a market the build doesn't list prints without one.
  const token = (raw: bigint): string => (unit === null ? "the token" : amountOf(raw, unit));
  const usdg = (raw: bigint): string => usdgAmount(raw, config.usdgDecimals);
  const per = unit === null ? "token" : unit.symbol;
  const side = e.order_id === null ? null : context.sideOf(e.order_id);
  const collateral = (raw: bigint): string => (side === 1 ? usdg(raw) : token(raw));
  const proceeds = (raw: bigint): string => (side === 1 ? token(raw) : usdg(raw));
  const ticker = market?.symbol ?? null;
  switch (e.name) {
    case "OrderPlaced": {
      const selling = a["side"] === 0;
      const size = units(a, "size");
      const rawUnit = market?.rawUnit ?? null;
      return {
        kind: "order",
        title: selling ? "Set a sell target" : "Set a buy target",
        detail: `${token(size)} at ${dollars(units(a, "target"))}, for at least ${premium(units(a, "minPremium"))} per ${per} a week`,
        amount: selling
          ? unit === null
            ? null
            : `-${token(size)}`
          : rawUnit === null
            ? null
            : `-${usdg((size * units(a, "target")) / rawUnit)}`,
        ticker,
      };
    }
    case "OrderUpdated":
      return {
        kind: "order",
        title: "Changed a target",
        detail: `Least payment ${premium(units(a, "minPremium"))} per ${per} a week`,
        amount: null,
        ticker,
      };
    case "OrderAmended":
      return {
        kind: "order",
        title: "Changed a target",
        detail: `Now ${token(units(a, "size"))} at ${dollars(units(a, "target"))}, for at least ${premium(units(a, "minPremium"))} per ${per} a week`,
        amount: null,
        ticker,
      };
    case "OrderCommitted":
      return {
        kind: "order",
        title: "Written into the week",
        detail: `${token(units(a, "amount"))} of the target is in this week's trade`,
        amount: null,
        ticker,
      };
    case "BatchFilled":
      return {
        kind: "earned",
        title: "Paid for the week",
        detail: `At the weekly batch, for ${token(units(a, "amount"))}`,
        amount: `+${usdg(units(a, "premiumValue"))}`,
        ticker,
      };
    case "QuoteFilled":
      return {
        kind: "earned",
        title: "Paid by quote",
        detail: `From ${a["teamOperated"] === true ? "the maker Vayle operates" : "a maker"}, for ${token(units(a, "amount"))}`,
        amount: `+${usdg(units(a, "premiumValue"))}`,
        ticker,
      };
    case "OrderSkipped":
      return {
        kind: "order",
        title: "Skipped a week",
        detail: `The bid was ${premium(units(a, "premium"))}, under the least you'd take, ${premium(units(a, "minPremium"))}`,
        amount: null,
        ticker,
      };
    case "OrderSettled": {
      const got = units(a, "proceeds");
      const back = units(a, "collateralBack");
      const renewed = units(a, "renewedSize");
      if (got > 0n) {
        return {
          kind: "filled",
          title: side === 1 ? "Filled: bought at your price" : "Filled: sold at your price",
          detail: back > 0n ? `${collateral(back)} came back too` : null,
          amount: `+${proceeds(got)}`,
          ticker,
        };
      }
      return {
        kind: "order",
        title: renewed > 0n ? "Settled and renewed" : "Settled",
        detail:
          renewed > 0n
            ? `${token(renewed)} goes on into next week`
            : `${collateral(back)} came back`,
        amount: renewed > 0n || back === 0n ? null : `+${collateral(back)}`,
        ticker,
      };
    }
    case "OrderCancelled": {
      const released = units(a, "released");
      return {
        kind: "order",
        title: "Stopped a target",
        detail: released > 0n ? null : "What's in this week's trade settles as normal",
        amount: released > 0n ? `+${collateral(released)}` : null,
        ticker,
      };
    }
    case "OrderClosed":
      return { kind: "order", title: "Closed a target", detail: null, amount: null, ticker };
    case "OrderFlipped":
      return {
        kind: "order",
        title: side === 1 ? "Set the sell target that follows" : "Set the buy target that follows",
        detail: `Target ${String(a["toId"])} picks up from here`,
        amount: null,
        ticker,
      };
    case "Withdrawn": {
      const address = typeof a["token"] === "string" ? a["token"] : "";
      const raw = units(a, "amount");
      if (address.toLowerCase() === config.usdg.toLowerCase()) {
        return {
          kind: "wallet",
          title: "Withdrew to your wallet",
          detail: null,
          amount: usdg(raw),
          ticker: CASH_SYMBOL,
        };
      }
      const withdrawn = marketOfToken(config.markets, address);
      return {
        kind: "wallet",
        title: "Withdrew to your wallet",
        detail: null,
        amount: withdrawn === undefined ? null : amountOf(raw, unitOf(withdrawn)),
        ticker: withdrawn?.symbol ?? null,
      };
    }
    default:
      return null;
  }
}

export function txUrl(config: AppConfig, hash: string): string | null {
  return config.explorerUrl === null ? null : `${config.explorerUrl}/tx/${hash}`;
}

export function addressUrl(config: AppConfig, address: string): string | null {
  return config.explorerUrl === null ? null : `${config.explorerUrl}/address/${address}`;
}
