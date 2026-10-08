import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleRequest, makerClients, readBidSheet, type ResponseCache } from "@vayle/maker";
import type { Accounts } from "./accounts.ts";
import type { Deployment } from "./deploy.ts";
import { makerConfig } from "./week.ts";

// The maker's bid sheet for the running fork, served the way its Worker serves it, so the app in
// fork mode shows the rates the fork's maker would pay. The Worker caches in Cloudflare's cache;
// here a response is kept in memory for as long as its cache-control allows.
export const BIDS_PORT = 5198;
export const BIDS_URL = `http://127.0.0.1:${BIDS_PORT}`;

function memoryCache(): ResponseCache {
  const kept = new Map<string, { readonly until: number; readonly response: Response }>();
  return {
    match(request) {
      const entry = kept.get(request.url);
      if (entry === undefined || entry.until < Date.now()) return Promise.resolve(undefined);
      return Promise.resolve(entry.response.clone());
    },
    put(request, response) {
      const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
      const seconds = maxAge === null ? 0 : Number(maxAge[1]);
      kept.set(request.url, { until: Date.now() + seconds * 1000, response });
      return Promise.resolve();
    },
  };
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(`${BIDS_URL}${req.url ?? "/"}`, { method: req.method ?? "GET", headers });
}

async function send(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(await response.text());
}

export function serveBids(deployment: Deployment, accounts: Accounts): Promise<never> {
  const config = makerConfig(deployment, accounts);
  const { public: client, signer } = makerClients(config);
  const cache = memoryCache();
  const server = createServer((req, res) => {
    void handleRequest(toRequest(req), {
      cache,
      waitUntil: (promise) => {
        void promise;
      },
      sheet: () => readBidSheet(config, client, signer.address),
    })
      .then((response) => send(response, res))
      .catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
  });
  return new Promise((_resolve, reject) => {
    server.once("error", reject);
    server.listen(BIDS_PORT, "127.0.0.1", () => {
      console.log(`The maker's bid sheet for the fork is at ${BIDS_URL}/v1/bids. Ctrl-C stops it.`);
    });
  });
}
