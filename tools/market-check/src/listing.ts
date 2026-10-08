import {
  selectEquityFeed,
  selectRegistryAsset,
  type DirectoryFeed,
  type RegistryAsset,
} from "@vayle/chain-facts/sources";

// Which Stock Tokens the check covers and which feed each one has, from the issuer's registry and
// the feed directory, picked with the same selectors the chain facts use for NVDA.

export interface Listed {
  readonly asset: RegistryAsset;
  // The token's primaryTokenizedPrice feed, or why there's none to use.
  readonly feed: DirectoryFeed | string;
}

export interface Listing {
  readonly tokens: readonly Listed[];
  // Registry symbols with no single deployment on the chain, and why.
  readonly skipped: readonly { readonly symbol: string; readonly reason: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every distinct tokenSymbol in the registry, in the order listed.
function registrySymbols(json: unknown): string[] {
  const assets = isRecord(json) && Array.isArray(json["assets"]) ? json["assets"] : [];
  const symbols = new Set<string>();
  for (const asset of assets) {
    if (isRecord(asset) && typeof asset["tokenSymbol"] === "string") {
      symbols.add(asset["tokenSymbol"]);
    }
  }
  return [...symbols];
}

export function listTokens(registry: unknown, directory: unknown, chainId: number): Listing {
  const tokens: Listed[] = [];
  const skipped: { symbol: string; reason: string }[] = [];
  for (const symbol of registrySymbols(registry)) {
    let asset: RegistryAsset;
    try {
      asset = selectRegistryAsset(registry, symbol, chainId);
    } catch (error) {
      skipped.push({ symbol, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let feed: DirectoryFeed | string;
    try {
      feed = selectEquityFeed(directory, symbol);
    } catch (error) {
      feed = `the feed directory lists ${error instanceof Error ? error.message : String(error)}`;
    }
    tokens.push({ asset, feed });
  }
  // By code point, so the order doesn't depend on a locale.
  tokens.sort((a, b) =>
    a.asset.symbol < b.asset.symbol ? -1 : a.asset.symbol > b.asset.symbol ? 1 : 0,
  );
  return { tokens, skipped };
}
