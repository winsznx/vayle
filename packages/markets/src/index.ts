// The markets Vayle lists, read from deployments/markets.json. The deploy script lists each one
// in the token registry and sets its caps, and the keeper, maker, watcher and app take every
// market parameter from here. Sell targets are the call side, buy targets the put side.
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { BPS, gridIsExact, isOnTick, isWholeLots } from "@vayle/units";
import file from "../../../deployments/markets.json" with { type: "json" };

export interface Caps {
  readonly openSize: bigint;
  readonly walletSize: bigint;
  readonly seriesOpenInterest: bigint;
  readonly fillSize: bigint;
}

export interface Side {
  readonly enabled: boolean;
  readonly caps: Caps;
}

export interface Market {
  readonly symbol: string;
  readonly token: Address;
  readonly uid: Hex;
  readonly decimals: number;
  readonly rawUnit: bigint;
  readonly feed: Address;
  readonly feedDecimals: number;
  readonly heartbeatSeconds: number;
  readonly lot: bigint;
  readonly priceTick: bigint;
  readonly strikeTick: bigint;
  readonly strikeRangeBps: number;
  // The price, in USDG base units per whole token, that strikeTick was derived from.
  readonly strikeStepBasis: { readonly priceUsdg: bigint; readonly block: bigint };
  readonly sell: Side;
  readonly buy: Side;
  // The maker prices this market at volBps, its realized volatility plus a margin.
  readonly maker: {
    readonly volBps: number;
    readonly realizedVolBps: number;
    readonly volMarginBps: number;
    readonly realizedVolBlock: bigint;
  };
}

export class BadMarkets extends Error {
  override readonly name = "BadMarkets";
}

// A strike step is about 2% of the price: 1, 2 or 5 times a power of ten, whichever is nearest in
// log terms, in USDG base units. $240 gives $5, $30 gives $0.50 and $600 gives $10.
export const STRIKE_STEP_PERCENT = 2n;

export function strikeStepFor(priceUsdg: bigint): bigint {
  if (priceUsdg <= 0n) throw new BadMarkets(`no strike step for price ${priceUsdg}`);
  const target = Number(priceUsdg * STRIKE_STEP_PERCENT) / 100;
  let best = 1n;
  let bestDistance = Infinity;
  for (let power = 1n; power <= 10n ** 15n; power *= 10n) {
    for (const mantissa of [1n, 2n, 5n]) {
      const step = mantissa * power;
      const distance = Math.abs(Math.log(Number(step) / target));
      if (distance < bestDistance) [best, bestDistance] = [step, distance];
    }
  }
  return best;
}

// Everything about a market the token registry and the market would refuse, plus the rules the
// file itself promises. An empty list means the market is consistent.
export function problemsOf(market: Market): string[] {
  const { lot, priceTick, strikeTick, strikeRangeBps, rawUnit } = market;
  if (lot <= 0n || priceTick <= 0n) return ["lot and price tick must be positive"];
  const problems: string[] = [];
  if (!gridIsExact(lot, priceTick, rawUnit)) problems.push("lot and price tick aren't exact");
  if (strikeTick === 0n || !isOnTick(strikeTick, priceTick)) {
    problems.push("strike tick isn't a multiple of the price tick");
  }
  if (strikeRangeBps <= 0 || BigInt(strikeRangeBps) >= BPS) {
    problems.push("strike range is outside 1 to 9,999 bps");
  }
  if (strikeTick !== strikeStepFor(market.strikeStepBasis.priceUsdg)) {
    problems.push("strike tick doesn't follow the strike step rule");
  }
  for (const [name, side] of [
    ["sell", market.sell],
    ["buy", market.buy],
  ] as const) {
    const { openSize, walletSize, seriesOpenInterest, fillSize } = side.caps;
    const caps = [openSize, walletSize, seriesOpenInterest, fillSize];
    if (side.enabled && caps.some((cap) => cap === 0n)) {
      problems.push(`${name} is enabled with a zero cap`);
    }
    if (!side.enabled && caps.some((cap) => cap !== 0n)) {
      problems.push(`${name} is disabled with a nonzero cap`);
    }
    if (caps.some((cap) => !isWholeLots(cap, lot) && cap !== 0n)) {
      problems.push(`${name} has a cap that isn't whole lots`);
    }
    if (walletSize > openSize || seriesOpenInterest > openSize || fillSize > seriesOpenInterest) {
      problems.push(`${name} caps don't nest: fill <= series <= open, wallet <= open`);
    }
  }
  const { volBps, realizedVolBps, volMarginBps } = market.maker;
  if (volBps !== realizedVolBps + volMarginBps || volBps <= 0) {
    problems.push("maker vol isn't realized vol plus the margin");
  }
  return problems;
}

type Json = Readonly<Record<string, unknown>>;

function record(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadMarkets(`${path} isn't an object`);
  }
  return value as Json;
}

function text(json: Json, key: string, path: string): string {
  const value = json[key];
  if (typeof value !== "string" || value === "") throw new BadMarkets(`${path}.${key} isn't text`);
  return value;
}

function whole(json: Json, key: string, path: string): number {
  const value = json[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BadMarkets(`${path}.${key} isn't a whole number`);
  }
  return value;
}

function big(json: Json, key: string, path: string): bigint {
  const value = text(json, key, path);
  if (!/^\d+$/.test(value)) throw new BadMarkets(`${path}.${key} isn't a decimal string`);
  return BigInt(value);
}

function flag(json: Json, key: string, path: string): boolean {
  const value = json[key];
  if (typeof value !== "boolean") throw new BadMarkets(`${path}.${key} isn't true or false`);
  return value;
}

function address(json: Json, key: string, path: string): Address {
  const value = text(json, key, path);
  if (!isAddress(value, { strict: true }) || getAddress(value) !== value) {
    throw new BadMarkets(`${path}.${key} isn't a checksummed address`);
  }
  return value;
}

function side(json: Json, key: string, path: string): Side {
  const at = `${path}.${key}`;
  const entry = record(json[key], at);
  return {
    enabled: flag(entry, "enabled", at),
    caps: {
      openSize: big(entry, "openSize", at),
      walletSize: big(entry, "walletSize", at),
      seriesOpenInterest: big(entry, "seriesOpenInterest", at),
      fillSize: big(entry, "fillSize", at),
    },
  };
}

function market(value: unknown, path: string): Market {
  const json = record(value, path);
  const uid = text(json, "uid", path);
  if (!isHex(uid) || uid.length !== 66) throw new BadMarkets(`${path}.uid isn't 32 bytes`);
  const decimals = whole(json, "decimals", path);
  const basis = record(json["strikeStepBasis"], `${path}.strikeStepBasis`);
  const maker = record(json["maker"], `${path}.maker`);
  return {
    symbol: text(json, "symbol", path),
    token: address(json, "token", path),
    uid,
    decimals,
    rawUnit: 10n ** BigInt(decimals),
    feed: address(json, "feed", path),
    feedDecimals: whole(json, "feedDecimals", path),
    heartbeatSeconds: whole(json, "heartbeatSeconds", path),
    lot: big(json, "lot", path),
    priceTick: big(json, "priceTick", path),
    strikeTick: big(json, "strikeTick", path),
    strikeRangeBps: whole(json, "strikeRangeBps", path),
    strikeStepBasis: {
      priceUsdg: big(basis, "priceUsdg", `${path}.strikeStepBasis`),
      block: big(basis, "block", `${path}.strikeStepBasis`),
    },
    sell: side(json, "sell", path),
    buy: side(json, "buy", path),
    maker: {
      volBps: whole(maker, "volBps", `${path}.maker`),
      realizedVolBps: whole(maker, "realizedVolBps", `${path}.maker`),
      volMarginBps: whole(maker, "volMarginBps", `${path}.maker`),
      realizedVolBlock: big(maker, "realizedVolBlock", `${path}.maker`),
    },
  };
}

// At least one market, NVDA first.
export type Markets = readonly [Market, ...Market[]];

export function parseMarkets(value: unknown): Markets {
  const json = record(value, "markets file");
  if (json["schemaVersion"] !== 1) throw new BadMarkets("schemaVersion isn't 1");
  const entries = json["markets"];
  if (!Array.isArray(entries)) throw new BadMarkets("markets isn't a list");
  const parsed = entries.map((entry: unknown, i) => market(entry, `markets[${i}]`));
  const [first, ...rest] = parsed;
  if (first === undefined) throw new BadMarkets("no markets");
  const symbols = new Set(parsed.map((m) => m.symbol));
  const tokens = new Set(parsed.map((m) => m.token));
  if (symbols.size !== parsed.length || tokens.size !== parsed.length) {
    throw new BadMarkets("a symbol or token is listed twice");
  }
  return [first, ...rest];
}

export const markets: Markets = parseMarkets(file);

// A market's listing as the token registry's asset() returns it.
export interface Listing {
  readonly uid: Hex;
  readonly feed: Address;
  readonly decimals: number;
  readonly feedDecimals: number;
  readonly rawUnit: bigint;
  readonly lot: bigint;
  readonly priceTick: bigint;
  readonly strikeTick: bigint;
  readonly strikeRangeBps: number;
  readonly listed: boolean;
}

// How a market's listing in the token registry differs from this file, one line per field both
// state. Empty when they agree. A service leaves a market alone while its listing differs, since the
// feed or grid in the file may not be the one the market uses.
export function listingDifferences(market: Market, listing: Listing): string[] {
  const fields: readonly (readonly [string, string | number | bigint, string | number | bigint])[] =
    [
      ["uid", listing.uid.toLowerCase(), market.uid.toLowerCase()],
      ["feed", getAddress(listing.feed), market.feed],
      ["decimals", listing.decimals, market.decimals],
      ["feedDecimals", listing.feedDecimals, market.feedDecimals],
      ["lot", listing.lot, market.lot],
      ["priceTick", listing.priceTick, market.priceTick],
      ["strikeTick", listing.strikeTick, market.strikeTick],
      ["strikeRangeBps", listing.strikeRangeBps, market.strikeRangeBps],
    ];
  return fields
    .filter(([, registry, file]) => registry !== file)
    .map(
      ([field, registry, file]) =>
        `${field} is ${registry.toString()} in the registry and ${file.toString()} in the markets file`,
    );
}

export function marketOf(token: Address): Market | undefined {
  const wanted = getAddress(token);
  return markets.find((m) => m.token === wanted);
}
