import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { runOnce } from "./run.ts";

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Cloudflare Worker entry: one run per cron tick.
export default {
  scheduled(
    _controller: unknown,
    env: Readonly<Record<string, string | undefined>>,
    ctx: ScheduledContext,
  ): void {
    const config = loadConfig(env);
    const chain = defineChain({
      id: facts.chain.chainId,
      name: "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    const transport = http(config.rpcUrl, { retryCount: 3 });
    const signer = privateKeyToAccount(config.key);
    const clients = {
      public: createPublicClient({ chain, transport }),
      wallet: createWalletClient({ account: signer, chain, transport }),
      signer,
    };
    ctx.waitUntil(runOnce(config, clients));
  },
};
