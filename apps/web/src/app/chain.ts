import { robinhoodChain } from "@vayle/chain-facts/chain";
import { createPublicClient, http, type PublicClient } from "viem";
import type { AppConfig } from "./config.ts";

// Reads started together at one block go out as one Multicall3 call. 16 KiB of calldata is about
// 450 single-argument reads per call.
const MULTICALL_BYTES = 16_384;
// How often a sent transaction's receipt is checked. Blocks come about ten a second, so once a
// second confirms quickly without asking every block.
const RECEIPT_POLL_MS = 1_000;

// The app reads through config.rpcUrl, the site's own /rpc in production. Wallets that add the chain
// get robinhoodChain's public RPC instead, never this one, which can carry a private key in its URL.
export function publicClientOf(config: AppConfig): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(config.rpcUrl),
    batch: { multicall: { batchSize: MULTICALL_BYTES } },
    pollingInterval: RECEIPT_POLL_MS,
  });
}
