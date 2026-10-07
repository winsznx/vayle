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
    ctx.waitUntil(runOnce(config, keeperClients(config)));
  },
};
