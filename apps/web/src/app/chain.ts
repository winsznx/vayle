import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { robinhood } from "viem/chains";
import facts from "../../../../deployments/robinhood-mainnet.json" with { type: "json" };
import type { AppConfig } from "./config.ts";

// The chain as a wallet should see it when it adds it: viem's name and native currency for chain
// 4663, and the public RPC and explorer from the chain facts, never the app's own RPC, which can
// carry a private key in its URL. The app's reads go through publicClientOf's transport instead.
export function chainOf(config: AppConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: robinhood.name,
    nativeCurrency: robinhood.nativeCurrency,
    rpcUrls: { default: { http: [facts.chain.publicRpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: facts.chain.explorerUrl } },
  });
}

export function publicClientOf(config: AppConfig): PublicClient {
  return createPublicClient({ chain: chainOf(config), transport: http(config.rpcUrl) });
}
