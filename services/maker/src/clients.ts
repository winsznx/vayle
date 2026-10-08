import { robinhoodChain } from "@vayle/chain-facts/chain";
import { createPublicClient, createWalletClient, http, type HttpTransportConfig } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { MakerConfig } from "./config.ts";
import type { Clients } from "./execute.ts";

// The RPC charges per request, whether it carries one read or a Multicall3 aggregate3 of hundreds.
// Reads started together at one block leave as one aggregate3 per this many bytes of calls, about
// 450 single-argument reads. Order reads measured about 30,000 gas each on the fork, so a full call
// stays near 14M, well under the node's eth_call cap of about 50M, however large the book grows.
export const MULTICALL_BYTES = 16_384;
// A request that fails is tried again this many times before the run gives up on it.
const RETRIES = 3;

// Reads batch through Multicall3 at the address in the chain facts. Transactions go out through
// the same RPC, signed by the maker's key. Tests pass their own fetch.
export function makerClients(
  config: Pick<MakerConfig, "rpcUrl" | "key">,
  rpcFetch?: HttpTransportConfig["fetchFn"],
): Clients {
  const transport = http(config.rpcUrl, { retryCount: RETRIES, fetchFn: rpcFetch });
  const signer = privateKeyToAccount(config.key);
  return {
    public: createPublicClient({
      chain: robinhoodChain,
      transport,
      batch: { multicall: { batchSize: MULTICALL_BYTES } },
    }),
    wallet: createWalletClient({ account: signer, chain: robinhoodChain, transport }),
    signer,
  };
}
