import { getAddress, isAddress, type Address } from "viem";
import facts from "../../../../deployments/robinhood-mainnet.json" with { type: "json" };

export interface AppConfig {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly market: Address;
  // Without it the app works and order history is hidden.
  readonly indexerUrl: string | null;
  readonly asset: Address;
  readonly assetSymbol: string;
  readonly assetDecimals: number;
  readonly usdg: Address;
  readonly usdgDecimals: number;
  readonly feed: Address;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

export interface Env {
  readonly VITE_RPC_URL?: string;
  readonly VITE_MARKET?: string;
  readonly VITE_INDEXER_URL?: string;
}

export function loadConfig(env: Env): ConfigResult {
  const missing: string[] = [];
  const rpcUrl = env.VITE_RPC_URL ?? "";
  if (rpcUrl === "") missing.push("VITE_RPC_URL");
  const market = env.VITE_MARKET ?? "";
  if (!isAddress(market)) missing.push("VITE_MARKET");
  if (missing.length > 0) return { ok: false, missing };
  const indexerUrl = env.VITE_INDEXER_URL ?? "";
  return {
    ok: true,
    config: {
      chainId: facts.chain.chainId,
      rpcUrl,
      market: getAddress(market),
      indexerUrl: indexerUrl === "" ? null : indexerUrl.replace(/\/$/, ""),
      asset: getAddress(facts.nvda.address),
      assetSymbol: facts.nvda.symbol,
      assetDecimals: facts.nvda.decimals,
      usdg: getAddress(facts.usdg.address),
      usdgDecimals: facts.usdg.decimals,
      feed: getAddress(facts.nvdaUsdFeed.proxy),
    },
  };
}
