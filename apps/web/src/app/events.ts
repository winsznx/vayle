import type { MarketEvent } from "@vayle/market";
import type { AppConfig } from "./config.ts";
import { dollars, premium, tokens, usdgAmount } from "./format.ts";

// A holder's events in their own words, for the activity list and an order's history. Credits
// aren't listed on their own: every credit comes with the fill, settlement or cancel that caused it,
// and that event already carries the amount.

export type EventKind = "earned" | "order" | "filled" | "wallet";

export interface EventLine {
  readonly kind: EventKind;
  readonly title: string;
  readonly detail: string | null;
  // What moved, from the holder's side: "+2.50 USDG" credited, "-1.00 NVDA" locked, and plain
  // amounts for withdrawals.
  readonly amount: string | null;
}

// 0 for a sell order, 1 for a buy order, from the order's placement.
export type SideOf = (orderId: string) => 0 | 1 | null;

export function sidesOf(events: readonly MarketEvent[]): SideOf {
  const sides = new Map<string, 0 | 1>();
  for (const e of events) {
    if (e.name !== "OrderPlaced" || e.order_id === null) continue;
    const side = e.args["side"];
    if (side === 0 || side === 1) sides.set(e.order_id, side);
  }
  return (orderId) => sides.get(orderId) ?? null;
}

function units(args: Readonly<Record<string, unknown>>, name: string): bigint {
  const value = args[name];
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

export function describeEvent(e: MarketEvent, config: AppConfig, sideOf: SideOf): EventLine | null {
  const a = e.args;
  const nvda = (raw: bigint): string => tokens(raw, config.assetSymbol, config.assetDecimals);
  const usdg = (raw: bigint): string => usdgAmount(raw, config.usdgDecimals);
  const side = e.order_id === null ? null : sideOf(e.order_id);
  const collateral = (raw: bigint): string => (side === 1 ? usdg(raw) : nvda(raw));
  const proceeds = (raw: bigint): string => (side === 1 ? nvda(raw) : usdg(raw));
  switch (e.name) {
    case "OrderPlaced": {
      const selling = a["side"] === 0;
      return {
        kind: "order",
        title: selling ? "Placed a sell order" : "Placed a buy order",
        detail: `${nvda(units(a, "size"))} at ${dollars(units(a, "target"))}, taking at least ${premium(units(a, "minPremium"))} per ${config.assetSymbol} a week`,
        amount: selling
          ? `-${nvda(units(a, "size"))}`
          : `-${usdg((units(a, "size") * units(a, "target")) / 10n ** BigInt(config.assetDecimals))}`,
      };
    }
    case "OrderUpdated":
      return {
        kind: "order",
        title: "Changed an order",
        detail: `Least ${premium(units(a, "minPremium"))} per ${config.assetSymbol} a week`,
        amount: null,
      };
    case "OrderCommitted":
      return {
        kind: "order",
        title: "Written into the week",
        detail: `${nvda(units(a, "amount"))} of the order is in this week's trade`,
        amount: null,
      };
    case "BatchFilled":
      return {
        kind: "earned",
        title: "Earned the week's premium",
        detail: `At the weekly batch, for ${nvda(units(a, "amount"))}`,
        amount: `+${usdg(units(a, "premiumValue"))}`,
      };
    case "QuoteFilled":
      return {
        kind: "earned",
        title: "Earned a premium",
        detail: `From ${a["teamOperated"] === true ? "the team-operated maker's" : "a maker's"} quote, for ${nvda(units(a, "amount"))}`,
        amount: `+${usdg(units(a, "premiumValue"))}`,
      };
    case "OrderSkipped":
      return {
        kind: "order",
        title: "Skipped a week",
        detail: `The bid was ${premium(units(a, "premium"))}, under the least you'd take, ${premium(units(a, "minPremium"))}`,
        amount: null,
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
        };
      }
      return {
        kind: "order",
        title: renewed > 0n ? "Settled and renewed" : "Settled",
        detail:
          renewed > 0n
            ? `${nvda(renewed)} goes on into next week`
            : `${collateral(back)} came back`,
        amount: renewed > 0n || back === 0n ? null : `+${collateral(back)}`,
      };
    }
    case "OrderCancelled": {
      const released = units(a, "released");
      return {
        kind: "order",
        title: "Stopped an order",
        detail: released > 0n ? null : "What's in this week's trade settles as normal",
        amount: released > 0n ? `+${collateral(released)}` : null,
      };
    }
    case "OrderClosed":
      return { kind: "order", title: "Closed an order", detail: null, amount: null };
    case "OrderFlipped":
      return {
        kind: "order",
        title: side === 1 ? "Placed the sell-back order" : "Placed the buy-back order",
        detail: `Order ${String(a["toId"])} picks up from here`,
        amount: null,
      };
    case "Withdrawn": {
      const token = typeof a["token"] === "string" ? a["token"].toLowerCase() : "";
      const amount = units(a, "amount");
      const what = token === config.asset.toLowerCase() ? nvda(amount) : usdg(amount);
      return { kind: "wallet", title: "Withdrew to your wallet", detail: null, amount: what };
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
