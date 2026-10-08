import { parseFixed } from "@vayle/units";
import { amountOf, step, type TokenUnit } from "./format.ts";
import type { Caps } from "./useMarket.ts";
import type { Epoch, Side } from "./week.ts";

// What the holder typed, checked before anything is signed. Problems are said in plain words.

export interface TicketInput {
  readonly side: Side;
  readonly strike: bigint;
  // Text as typed: an amount of the token and the least payment in USDG per token.
  readonly amount: string;
  readonly minPremium: string;
}

export interface Balances {
  readonly asset: bigint;
  readonly usdg: bigint;
}

export interface CheckedTicket {
  readonly size: bigint;
  readonly minPremium: bigint;
  // What the target locks: the token for a sell target, USDG for a buy target.
  readonly collateral: bigint;
}

export type TicketResult =
  | { readonly ok: true; readonly ticket: CheckedTicket }
  | { readonly ok: false; readonly problem: string };

export function checkTicket(
  input: TicketInput,
  e: Epoch,
  balances: Balances,
  usdgDecimals: number,
  unit: TokenUnit,
): TicketResult {
  const size = parseFixed(input.amount, unit.decimals);
  if (size === null || size === 0n) {
    return {
      ok: false,
      problem: `Enter how much ${unit.symbol} you'd ${input.side === "sell" ? "sell" : "buy"}.`,
    };
  }
  if (size % e.lot !== 0n) {
    return { ok: false, problem: `Amounts go in steps of ${amountOf(e.lot, unit)}.` };
  }
  const minPremium = parseFixed(input.minPremium === "" ? "0" : input.minPremium, usdgDecimals);
  if (minPremium === null) {
    return { ok: false, problem: "Enter the least payment in dollars." };
  }
  if (minPremium % e.priceTick !== 0n) {
    return {
      ok: false,
      problem: `The least payment goes in steps of ${step(e.priceTick, usdgDecimals)}.`,
    };
  }
  if (input.side === "sell") {
    if (size > balances.asset) {
      return { ok: false, problem: `That's more ${unit.symbol} than this wallet holds.` };
    }
    return { ok: true, ticket: { size, minPremium, collateral: size } };
  }
  const collateral = (size * input.strike) / e.rawUnit;
  if (collateral > balances.usdg) {
    return { ok: false, problem: "Buying that much needs more USDG than this wallet holds." };
  }
  return { ok: true, ticket: { size, minPremium, collateral } };
}

// How much more of one side this wallet can place right now under the market's caps, in raw token
// units: what's left of the side's total and of the wallet's own share, whichever is less. A
// target being changed counts its own size as released first, as the market does.
export function roomUnderCaps(caps: Caps, open: bigint, walletOpen: bigint, released = 0n): bigint {
  const market = caps.openSize + released - open;
  const wallet = caps.walletSize + released - walletOpen;
  const room = market < wallet ? market : wallet;
  return room > 0n ? room : 0n;
}

// Why a target of `size` doesn't fit under the caps, or null when it does.
export function capProblem(
  size: bigint,
  room: bigint,
  caps: Caps,
  side: Side,
  unit: TokenUnit,
): string | null {
  if (size <= room) return null;
  if (caps.openSize === 0n) {
    return side === "buy" ? "Buy targets aren't open yet." : "Sell targets aren't open yet.";
  }
  if (room === 0n) return `The market is at its limit for ${side} targets right now.`;
  return `That's over the market's limit for now. Up to ${amountOf(room, unit)} fits.`;
}
