import { robinhoodChain } from "@vayle/chain-facts/chain";
import { createPublicClient, http, type HttpTransportConfig, type PublicClient } from "viem";

// The RPC bills per call, whatever a call carries, so reads started together at one block go out
// as one Multicall3 call, split at 32 KiB of calldata.
export const MULTICALL_BYTES = 32_768;
// A request that fails is tried again this many times before the run gives up on it, waiting 0.3 s
// and then twice as long each time. The chain's public RPC refuses some requests from Cloudflare's
// shared addresses as too many, so a run rides out up to about a minute of refusals.
const RETRIES = 8;
const RETRY_DELAY_MS = 300;

// Reads batch through Multicall3 at the address in the chain facts. Tests pass their own fetch.
export function watcherClient(
  rpcUrl: string,
  rpcFetch?: HttpTransportConfig["fetchFn"],
): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl, { retryCount: RETRIES, retryDelay: RETRY_DELAY_MS, fetchFn: rpcFetch }),
    batch: { multicall: { batchSize: MULTICALL_BYTES } },
  });
}
