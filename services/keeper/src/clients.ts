import { robinhoodChain } from "@vayle/chain-facts/chain";
import { createPublicClient, createWalletClient, http, type HttpTransportConfig } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { KeeperConfig } from "./config.ts";
import type { Clients } from "./execute.ts";

// The RPC bills per call, whatever a call carries, so reads started together at one block go out
// as one Multicall3 call, split at 32 KiB of calldata. Order reads, the only large ones, go in
// calls of their own sized well under the node's gas cap (snapshot.ts).
export const MULTICALL_BYTES = 32_768;
// A request that fails is tried again this many times before the run gives up on it, waiting 0.3 s
// and then twice as long each time. The chain's public RPC refuses some requests from Cloudflare's
// shared addresses as too many, so a run rides out up to about a minute of refusals.
const RETRIES = 8;
const RETRY_DELAY_MS = 300;

// Reads batch through Multicall3 at the address in the chain facts. Transactions go out through
// the same RPC, signed by the keeper's key, which holds gas only. Tests pass their own fetch.
export function keeperClients(
  config: Pick<KeeperConfig, "rpcUrl" | "key">,
  rpcFetch?: HttpTransportConfig["fetchFn"],
): Clients {
  const transport = http(config.rpcUrl, {
    retryCount: RETRIES,
    retryDelay: RETRY_DELAY_MS,
    fetchFn: rpcFetch,
  });
  return {
    public: createPublicClient({
      chain: robinhoodChain,
      transport,
      batch: { multicall: { batchSize: MULTICALL_BYTES } },
    }),
    wallet: createWalletClient({
      account: privateKeyToAccount(config.key),
      chain: robinhoodChain,
      transport,
    }),
  };
}
