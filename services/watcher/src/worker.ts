import { redacted } from "@vayle/chain-facts/rpc-errors";
import { robinhoodChain } from "@vayle/chain-facts/chain";
import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.ts";
import { runOnce } from "./run.ts";

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

// The RPC bills per call, whatever a call carries, so reads started together at one block go out
// as one Multicall3 call, split at 32 KiB of calldata.
const MULTICALL_BYTES = 32_768;

// Cloudflare Worker entry: one run per cron tick. Vars and secrets arrive as env strings.
export default {
  scheduled(
    _controller: unknown,
    env: Readonly<Record<string, string | undefined>>,
    ctx: ScheduledContext,
  ): void {
    const config = loadConfig(env);
    const client = createPublicClient({
      chain: robinhoodChain,
      transport: http(config.rpcUrl, { retryCount: 3 }),
      batch: { multicall: { batchSize: MULTICALL_BYTES } },
    });
    // A failed run is logged by the runtime, so it carries the error's text without the RPC's URL.
    ctx.waitUntil(
      runOnce(config, { client, fetch: (input, init) => fetch(input, init) }).catch(
        (error: unknown) => {
          throw redacted(error);
        },
      ),
    );
  },
};
