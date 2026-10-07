import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import type { AppConfig } from "./config.ts";

export function chainOf(config: AppConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

export function publicClientOf(config: AppConfig): PublicClient {
  return createPublicClient({ chain: chainOf(config), transport: http(config.rpcUrl) });
}
