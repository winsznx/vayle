import type { Market } from "@vayle/markets";
import { getAddress, isAddress, type Address } from "viem";
import type { MakerBids } from "./rates.ts";
import type { Epoch } from "./week.ts";

// The maker's bid sheet, GET <maker>/v1/bids: what it would pay right now per target, per market,
// for the week it priced. Integers past 2^53 come as decimal strings. It's read defensively: an
// entry that doesn't parse is left out, and a sheet for another chain or market contract is
// ignored whole.

export interface SheetBid {
  // USDG base units per whole token.
  readonly target: bigint;
  readonly premium: bigint;
  // Raw token units the bid covers.
  readonly maxAmount: bigint;
}

export interface SheetMarket {
  readonly token: Address;
  readonly symbol: string;
  // The week the bids are for, by its expiry in seconds.
  readonly expiry: number;
  // The feed round and its time the maker priced on.
  readonly priceRound: bigint;
  readonly priceUpdatedAt: number;
  readonly volBps: number;
  readonly sell: readonly SheetBid[];
  readonly buy: readonly SheetBid[];
}

export interface BidSheet {
  readonly chainId: number;
  readonly market: Address;
  readonly block: bigint;
  // When the maker computed the sheet, in seconds.
  readonly computedAt: number;
  readonly markets: readonly SheetMarket[];
}

type Json = Readonly<Record<string, unknown>>;

// Seconds since 1970 stay well under this until the year 5138, so anything larger isn't seconds.
const MAX_SECONDS = 100_000_000_000;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

// A non-negative integer, as a decimal string or a safe integer.
function integer(value: unknown): bigint | null {
  if (typeof value === "string") return /^\d+$/.test(value) ? BigInt(value) : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

function small(value: unknown): number | null {
  const n = integer(value);
  return n === null || n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);
}

// A time in seconds, as an integer or an ISO 8601 string.
function seconds(value: unknown): number | null {
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const n = small(value);
  return n === null || n >= MAX_SECONDS ? null : n;
}

function address(value: unknown): Address | null {
  return typeof value === "string" && isAddress(value, { strict: false })
    ? getAddress(value)
    : null;
}

// One side's bids. A bid that doesn't parse, pays nothing or covers nothing is left out, and a
// target listed twice keeps its first bid.
function bidsOf(value: unknown): SheetBid[] {
  if (!Array.isArray(value)) return [];
  const bids: SheetBid[] = [];
  for (const entry of value as unknown[]) {
    const json = record(entry);
    if (json === null) continue;
    const target = integer(json["target"]);
    const premium = integer(json["premium"]);
    const maxAmount = integer(json["maxAmount"]);
    if (target === null || premium === null || maxAmount === null) continue;
    if (target === 0n || premium === 0n || maxAmount === 0n) continue;
    if (bids.some((b) => b.target === target)) continue;
    bids.push({ target, premium, maxAmount });
  }
  return bids;
}

function marketOf(value: unknown): SheetMarket | null {
  const json = record(value);
  if (json === null) return null;
  const token = address(json["token"]);
  const symbol = json["symbol"];
  const expiry = seconds(json["expiry"]);
  const priceRound = integer(json["priceRound"]);
  const priceUpdatedAt = seconds(json["priceUpdatedAt"]);
  const volBps = small(json["volBps"]);
  const sides = record(json["sides"]);
  if (token === null || typeof symbol !== "string" || expiry === null || sides === null) {
    return null;
  }
  if (priceRound === null || priceUpdatedAt === null || volBps === null) return null;
  return {
    token,
    symbol,
    expiry,
    priceRound,
    priceUpdatedAt,
    volBps,
    sell: bidsOf(sides["sell"]),
    buy: bidsOf(sides["buy"]),
  };
}

// The sheet, or null when it doesn't parse or was computed for another chain or market contract
// than this build's.
export function parseBidSheet(
  value: unknown,
  build: { readonly chainId: number; readonly market: Address },
): BidSheet | null {
  const json = record(value);
  const source = record(json?.["source"]);
  if (json === null || source === null) return null;
  const chainId = small(source["chainId"]);
  const market = address(source["market"]);
  const block = integer(source["block"]);
  const computedAt = seconds(json["computedAt"]);
  const markets = json["markets"];
  if (chainId === null || market === null || block === null || computedAt === null) return null;
  if (chainId !== build.chainId || market !== build.market || !Array.isArray(markets)) return null;
  return {
    chainId,
    market,
    block,
    computedAt,
    markets: (markets as unknown[]).flatMap((entry) => {
      const parsed = marketOf(entry);
      return parsed === null ? [] : [parsed];
    }),
  };
}

// One market's bids on the sheet, for the week the market has open, or null when the sheet has
// none for that week.
export function makerBidsOf(
  sheet: BidSheet | null,
  market: Market,
  epoch: Epoch,
): MakerBids | null {
  const entry = sheet?.markets.find((m) => m.token === market.token && m.expiry === epoch.expiry);
  if (sheet === null || entry === undefined) return null;
  const byTarget = (bids: readonly SheetBid[]): Map<bigint, bigint> =>
    new Map(bids.map((b) => [b.target, b.premium] as const));
  return { computedAt: sheet.computedAt, sell: byTarget(entry.sell), buy: byTarget(entry.buy) };
}
