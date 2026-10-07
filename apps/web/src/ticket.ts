import type { Epoch, Side } from "./week.ts";

// What the holder typed, checked before anything is signed. Problems are said in plain words.

export interface TicketInput {
  readonly side: Side;
  readonly strike: bigint;
  // Text as typed: an amount of NVDA and a minimum premium in USDG per NVDA.
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
  // What the order locks: NVDA for a sell order, USDG for a buy order.
  readonly collateral: bigint;
}

export type TicketResult =
  | { readonly ok: true; readonly ticket: CheckedTicket }
  | { readonly ok: false; readonly problem: string };

const NUMBER = /^\d+(\.\d+)?$/;

// Parses "1.25" into base units, refusing more decimal places than the unit allows.
export function parseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0"));
}

export function checkTicket(
  input: TicketInput,
  e: Epoch,
  balances: Balances,
  usdgDecimals: number,
  assetDecimals: number,
): TicketResult {
  const size = parseUnits(input.amount, assetDecimals);
  if (size === null || size === 0n)
    return { ok: false, problem: "Enter how much NVDA, like 0.50." };
  if (size % e.lot !== 0n) return { ok: false, problem: "Amounts go in steps of 0.01 NVDA." };
  const minPremium = parseUnits(input.minPremium === "" ? "0" : input.minPremium, usdgDecimals);
  if (minPremium === null)
    return { ok: false, problem: "Enter the minimum premium in dollars, like 0.50." };
  if (minPremium % e.priceTick !== 0n) {
    return { ok: false, problem: "The minimum premium goes in steps of $0.0001." };
  }
  if (input.side === "sell") {
    if (size > balances.asset)
      return { ok: false, problem: "That's more NVDA than this wallet holds." };
    return { ok: true, ticket: { size, minPremium, collateral: size } };
  }
  const collateral = (size * input.strike) / e.rawUnit;
  if (collateral > balances.usdg) {
    return { ok: false, problem: "Buying that much needs more USDG than this wallet holds." };
  }
  return { ok: true, ticket: { size, minPremium, collateral } };
}
