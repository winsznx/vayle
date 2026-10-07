import { getAddress, isAddress, type Address } from "viem";
import facts from "../../../../deployments/robinhood-mainnet.json" with { type: "json" };

export interface AppConfig {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly market: Address;
  // Where history comes from. With the indexer, the app reads it from there. Without it, the app
  // reads the market's events straight from the chain, starting at the deploy block. With
  // neither, history is hidden and everything else works.
  readonly indexerUrl: string | null;
  readonly deployBlock: bigint | null;
  // Mobile wallets connect through WalletConnect, which needs a project ID. Without one, browser
  // wallets still connect.
  readonly walletConnectProjectId: string | null;
  // Whether this build takes new orders. Off unless the build sets VITE_PLACEMENT=open, so a hosted
  // build stays read-only for placement even after the disclosures are published. Settling,
  // stopping and withdrawing never depend on it.
  readonly placement: boolean;
  readonly asset: Address;
  readonly assetSymbol: string;
  readonly assetDecimals: number;
  readonly usdg: Address;
  readonly usdgDecimals: number;
  readonly feed: Address;
  // The chain's block explorer, for links to transactions and contracts. Null leaves them unlinked.
  readonly explorerUrl: string | null;
}

export type ConfigResult =
  | { readonly ok: true; readonly config: AppConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

export interface Env {
  readonly VITE_RPC_URL?: string;
  readonly VITE_MARKET?: string;
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_PLACEMENT?: string;
  readonly VITE_MARKET_DEPLOY_BLOCK?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}

export function loadConfig(env: Env): ConfigResult {
  const missing: string[] = [];
  const rpcUrl = env.VITE_RPC_URL ?? "";
  if (rpcUrl === "") missing.push("VITE_RPC_URL");
  const market = env.VITE_MARKET ?? "";
  if (!isAddress(market)) missing.push("VITE_MARKET");
  const deployBlock = env.VITE_MARKET_DEPLOY_BLOCK ?? "";
  if (deployBlock !== "" && !/^\d+$/.test(deployBlock)) missing.push("VITE_MARKET_DEPLOY_BLOCK");
  if (missing.length > 0) return { ok: false, missing };
  const indexerUrl = env.VITE_INDEXER_URL ?? "";
  const projectId = env.VITE_WALLETCONNECT_PROJECT_ID ?? "";
  return {
    ok: true,
    config: {
      chainId: facts.chain.chainId,
      rpcUrl,
      market: getAddress(market),
      indexerUrl: indexerUrl === "" ? null : indexerUrl.replace(/\/$/, ""),
      deployBlock: deployBlock === "" ? null : BigInt(deployBlock),
      walletConnectProjectId: projectId === "" ? null : projectId,
      placement: env.VITE_PLACEMENT === "open",
      asset: getAddress(facts.nvda.address),
      assetSymbol: facts.nvda.symbol,
      assetDecimals: facts.nvda.decimals,
      usdg: getAddress(facts.usdg.address),
      usdgDecimals: facts.usdg.decimals,
      feed: getAddress(facts.nvdaUsdFeed.proxy),
      explorerUrl: facts.chain.explorerUrl,
    },
  };
}
