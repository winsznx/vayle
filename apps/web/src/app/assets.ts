import type { Market } from "@vayle/markets";
import { getAddress, isAddress } from "viem";

// Which Stock Token market a page shows. The choice lives in the URL as ?asset=<ticker>, so a link
// opens the same market, and a page without one shows the first market the build lists.

export const ASSET_PARAM = "asset";

export class NoMarkets extends Error {
  override readonly name = "NoMarkets";
}

// The market the URL names by its ticker, in any case, or the first listed when it names none or
// one the build doesn't list.
export function selectMarket(markets: readonly Market[], asked: string | null): Market {
  const first = markets.at(0);
  if (first === undefined) throw new NoMarkets("The build lists no markets.");
  if (asked === null) return first;
  const wanted = asked.trim().toUpperCase();
  return markets.find((m) => m.symbol.toUpperCase() === wanted) ?? first;
}

// The listed market whose token is at `token`, matched whatever the address's casing.
export function marketOfToken(markets: readonly Market[], token: string): Market | undefined {
  if (!isAddress(token, { strict: false })) return undefined;
  const wanted = getAddress(token);
  return markets.find((m) => m.token === wanted);
}

// A path that keeps the market the URL names, so moving between pages stays on it.
export function withAsset(path: string, asked: string | null): string {
  if (asked === null) return path;
  const [pathname = path, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set(ASSET_PARAM, asked);
  return `${pathname}?${params.toString()}`;
}
