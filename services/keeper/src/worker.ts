import { redacted } from "@vayle/chain-facts/rpc-errors";
import { keeperClients } from "./clients.ts";
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
    // A failed run is logged by the runtime, so it carries the error's text without the RPC's URL.
    ctx.waitUntil(
      runOnce(config, keeperClients(config)).catch((error: unknown) => {
        throw redacted(error);
      }),
    );
  },
};
