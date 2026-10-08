import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpRequestError } from "viem";
import { CACHE_SECONDS, handleRequest, type ResponseCache } from "../src/http.ts";
import type { BidSheet } from "../src/sheet.ts";

const SHEET: BidSheet = {
  computedAt: 1_791_374_400,
  source: {
    chainId: 4663,
    market: "0x00000000000000000000000000000000000000aA",
    block: 82_900_000,
  },
  markets: [],
};
const URL_BASE = "https://maker.example.test";

// A cache in memory, keyed by URL like the Workers cache.
function memoryCache(): ResponseCache & { readonly keys: string[] } {
  const stored = new Map<string, Response>();
  return {
    keys: [],
    match: (request) => Promise.resolve(stored.get(request.url)?.clone()),
    put(request, response) {
      this.keys.push(request.url);
      stored.set(request.url, response);
      return Promise.resolve();
    },
  };
}

// The route with a sheet that counts its reads, and every cache write awaited before it returns.
function route(sheet: () => Promise<BidSheet> = () => Promise.resolve(SHEET)) {
  const cache = memoryCache();
  const pending: Promise<unknown>[] = [];
  let reads = 0;
  const handle = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await handleRequest(new Request(`${URL_BASE}${path}`, init), {
      cache,
      sheet: () => {
        reads += 1;
        return sheet();
      },
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
    return response;
  };
  return { handle, cache, reads: () => reads };
}

function from(origin: string): RequestInit {
  return { headers: { origin } };
}

describe("GET /v1/bids", () => {
  it("serves the sheet as JSON, cached for a minute, to the site", async () => {
    // #given
    const { handle } = route();
    // #when
    const response = await handle("/v1/bids", from("https://vayle.xyz"));
    // #then
    assert.deepEqual(
      [
        response.status,
        response.headers.get("content-type"),
        response.headers.get("cache-control"),
        response.headers.get("access-control-allow-origin"),
        response.headers.get("vary"),
        await response.json(),
      ],
      [
        200,
        "application/json",
        `public, max-age=${CACHE_SECONDS}`,
        "https://vayle.xyz",
        "Origin",
        SHEET,
      ],
    );
  });

  it("allows the app's local dev servers", async () => {
    // #given
    const { handle } = route();
    // #when
    const origins = await Promise.all(
      ["http://localhost:5173", "http://localhost:5191"].map(async (origin) =>
        (await handle("/v1/bids", from(origin))).headers.get("access-control-allow-origin"),
      ),
    );
    // #then
    assert.deepEqual(origins, ["http://localhost:5173", "http://localhost:5191"]);
  });

  it("gives any other page no permission to read it", async () => {
    // #given
    const { handle } = route();
    // #when
    const response = await handle("/v1/bids", from("https://elsewhere.example"));
    // #then
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  it("reads the chain once for requests within the cache's minute, query strings included", async () => {
    // #given
    const { handle, reads } = route();
    // #when
    await handle("/v1/bids", from("https://vayle.xyz"));
    await handle("/v1/bids?fresh=1", from("http://localhost:5173"));
    const third = await handle("/v1/bids");
    // #then
    assert.deepEqual([reads(), third.status], [1, 200]);
  });

  it("sends a cached sheet with the asking page's origin", async () => {
    // #given: a sheet cached for the site
    const { handle } = route();
    await handle("/v1/bids", from("https://vayle.xyz"));
    // #when
    const response = await handle("/v1/bids", from("http://localhost:5191"));
    // #then
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5191");
  });

  it("answers a failed read with its error, without the RPC's path, and caches that too", async () => {
    // #given: a read that fails with the RPC's key in the URL its message names
    const { handle, reads } = route(() =>
      Promise.reject(
        new HttpRequestError({
          url: "https://rpc.example/v2/secret-key",
          status: 502,
          details: "POST https://rpc.example/v2/secret-key answered 502",
        }),
      ),
    );
    // #when
    const first = await handle("/v1/bids");
    const body = (await first.json()) as { error: string };
    await handle("/v1/bids");
    // #then
    assert.deepEqual(
      [
        first.status,
        body.error.includes("secret-key"),
        body.error.includes("rpc.example"),
        reads(),
      ],
      [503, false, true, 1],
    );
  });
});

describe("the maker's other routes", () => {
  it("answers a preflight from the site", async () => {
    // #given
    const { handle } = route();
    // #when
    const response = await handle("/v1/bids", {
      method: "OPTIONS",
      headers: { origin: "https://vayle.xyz", "access-control-request-method": "GET" },
    });
    // #then
    assert.deepEqual(
      [
        response.status,
        response.headers.get("access-control-allow-origin"),
        response.headers.get("access-control-allow-methods"),
      ],
      [204, "https://vayle.xyz", "GET"],
    );
  });

  it("refuses anything but GET", async () => {
    // #given
    const { handle, reads } = route();
    // #when
    const response = await handle("/v1/bids", { method: "POST" });
    // #then
    assert.deepEqual(
      [response.status, response.headers.get("allow"), reads()],
      [405, "GET, OPTIONS", 0],
    );
  });

  it("knows no other path", async () => {
    // #given
    const { handle, reads } = route();
    // #when
    const response = await handle("/v1/quotes");
    // #then
    assert.deepEqual([response.status, reads()], [404, 0]);
  });
});
