import { amendOrder, approve, updateOrder, type Call, type OrderState } from "@vayle/market";
import { parseFixed } from "@vayle/units";
import { maxUint256, type Address } from "viem";
import { capProblem, checkTicket, roomUnderCaps } from "./ticket.ts";
import type { BySide, Caps } from "./useMarket.ts";
import type { Epoch } from "./week.ts";

// What changing an order takes, worked out before anything is signed. An idle order takes a new
// price, amount and least premium through one amend, and only the difference in what it locks
// moves. Once part of it is in this week's trade, only the least premium can change.

export interface EditInput {
  readonly target: bigint;
  // Text as typed, as on the ticket.
  readonly amount: string;
  readonly minimum: string;
}

export interface Holdings {
  readonly balanceAsset: bigint;
  readonly balanceUsdg: bigint;
  readonly allowanceAsset: bigint;
  readonly allowanceUsdg: bigint;
  readonly walletOpen: BySide<bigint>;
}

// The market's caps and how much each side holds now.
export interface Limits {
  readonly caps: BySide<Caps>;
  readonly open: BySide<bigint>;
}

export interface Addresses {
  readonly market: Address;
  readonly asset: Address;
  readonly usdg: Address;
}

// How what the order locks changes: more taken from the wallet, or some freed to withdraw. In NVDA
// for a sell order and USDG for a buy order.
export interface Move {
  readonly direction: "locks" | "frees";
  readonly amount: bigint;
}

export type EditPlan =
  | { readonly kind: "unchanged" }
  | { readonly kind: "problem"; readonly problem: string }
  | { readonly kind: "ready"; readonly calls: readonly Call[]; readonly move: Move | null };

export function planEdit(
  order: OrderState,
  input: EditInput,
  epoch: Epoch,
  holdings: Holdings,
  addresses: Addresses,
  limits: Limits,
  units: { readonly usdg: number; readonly asset: number; readonly symbol: string },
): EditPlan {
  const selling = order.side === 0;
  if (order.series !== 0n) {
    const least = parseFixed(input.minimum === "" ? "0" : input.minimum, units.usdg);
    if (least === null || least % epoch.priceTick !== 0n) {
      return { kind: "problem", problem: "The least premium goes in steps of $0.0001, like 0.50." };
    }
    if (least === order.minPremium) return { kind: "unchanged" };
    return {
      kind: "ready",
      calls: [updateOrder(addresses.market, order.id, least, order.flip, order.flipTarget)],
      move: null,
    };
  }

  // The amend releases what the order locks now before it takes what the new terms need, so the
  // wallet only has to cover the difference.
  const held = selling ? order.size : (order.size * order.target) / epoch.rawUnit;
  const checked = checkTicket(
    {
      side: selling ? "sell" : "buy",
      strike: input.target,
      amount: input.amount,
      minPremium: input.minimum,
    },
    epoch,
    {
      asset: holdings.balanceAsset + (selling ? held : 0n),
      usdg: holdings.balanceUsdg + (selling ? 0n : held),
    },
    units.usdg,
    units.asset,
  );
  if (!checked.ok) return { kind: "problem", problem: checked.problem };
  const { size, minPremium, collateral } = checked.ticket;
  const side = selling ? "sell" : "buy";
  const room = roomUnderCaps(
    limits.caps[side],
    limits.open[side],
    holdings.walletOpen[side],
    order.size,
  );
  const overCap = capProblem(size, room, limits.caps[side], side, units.symbol, units.asset);
  if (overCap !== null) return { kind: "problem", problem: overCap };
  if (input.target === order.target && size === order.size && minPremium === order.minPremium) {
    return { kind: "unchanged" };
  }

  const extra = collateral > held ? collateral - held : 0n;
  const allowance = selling ? holdings.allowanceAsset : holdings.allowanceUsdg;
  const calls: Call[] = [];
  if (extra > 0n && allowance < extra) {
    calls.push(approve(selling ? addresses.asset : addresses.usdg, addresses.market, maxUint256));
  }
  calls.push(
    amendOrder(addresses.market, order.id, {
      target: input.target,
      minPremium,
      size,
      flip: order.flip,
      flipTarget: order.flipTarget,
    }),
  );
  const move: Move | null =
    collateral > held
      ? { direction: "locks", amount: collateral - held }
      : collateral < held
        ? { direction: "frees", amount: held - collateral }
        : null;
  return { kind: "ready", calls, move };
}
