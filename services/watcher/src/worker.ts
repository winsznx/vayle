import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.ts";
import { runOnce } from "./run.ts";

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Cloudflare Worker entry: one run per cron tick. Vars and secrets arrive as env strings.
export default {
  scheduled(
    _controller: unknown,
    env: Readonly<Record<string, string | undefined>>,
    ctx: ScheduledContext,
  ): void {
    const config = loadConfig(env);
    const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 3 }) });
    ctx.waitUntil(runOnce(config, { client, fetch: (input, init) => fetch(input, init) }));
  },
};
