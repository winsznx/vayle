import { redacted } from "@vayle/chain-facts/rpc-errors";
import { makerClients } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { handleRequest, type ResponseCache } from "./http.ts";
import { runOnce } from "./run.ts";
import { readBidSheet } from "./sheet.ts";

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}

type Env = Readonly<Record<string, string | undefined>>;

// The Workers runtime's default cache.
declare const caches: { readonly default: ResponseCache };

// Cloudflare Worker entry: one run per cron tick, and the bid sheet on request.
export default {
  scheduled(_controller: unknown, env: Env, ctx: WorkerContext): void {
    const config = loadConfig(env);
    // A failed run is logged by the runtime, so it carries the error's text without the RPC's URL.
    ctx.waitUntil(
      runOnce(config, makerClients(config)).catch((error: unknown) => {
        throw redacted(error);
      }),
    );
  },

  fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    return handleRequest(request, {
      cache: caches.default,
      waitUntil: (promise) => {
        ctx.waitUntil(promise);
      },
      sheet: async () => {
        const config = loadConfig(env);
        const { public: client, signer } = makerClients(config);
        return readBidSheet(config, client, signer.address);
      },
    });
  },
};
