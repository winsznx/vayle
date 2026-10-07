import { redacted } from "@vayle/chain-facts/rpc-errors";
import { handle } from "./api.ts";
import { loadConfig } from "./config.ts";
import { apiDeps, chainClient, indexOnce } from "./indexing.ts";

type Env = Readonly<Record<string, string | undefined>>;

interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

// The Cloudflare Worker: the cron indexes, and requests read the API.
export default {
  scheduled(_controller: unknown, env: Env, ctx: ScheduledContext): void {
    const config = loadConfig(env);
    // A failed pass is logged by the runtime, so it carries the error's text without the RPC's URL.
    ctx.waitUntil(
      indexOnce(config, chainClient(config.rpcUrl)).catch((error: unknown) => {
        throw redacted(error);
      }),
    );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, apiDeps(loadConfig(env)));
  },
};
