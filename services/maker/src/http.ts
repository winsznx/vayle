import { errorText } from "@vayle/chain-facts/rpc-errors";
import type { BidSheet } from "./sheet.ts";

// The maker's one public route: GET /v1/bids, the bid sheet as JSON. Every response is cached for a
// minute under one key, so however many requests arrive, the sheet reads the chain at most once a
// minute in each Cloudflare location. A query string doesn't change the key.

export const BIDS_PATH = "/v1/bids";
export const CACHE_SECONDS = 60;
// The pages that may read the sheet from a browser: the site and the app's local dev servers.
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  "https://vayle.xyz",
  "http://localhost:5173",
  "http://localhost:5191",
]);

// The part of the Workers Cache API the route uses.
export interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface BidsDeps {
  readonly cache: ResponseCache;
  // Reads the chain and prices the sheet, only when the cache has none.
  readonly sheet: () => Promise<BidSheet>;
  // Keeps the cache write going after the response is sent.
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin !== null && ALLOWED_ORIGINS.has(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin" }
    : { vary: "Origin" };
}

// Cached responses carry no origin of their own, so each is sent with the asking page's.
function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cacheControl },
  });
}

export async function handleRequest(request: Request, deps: BidsDeps): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (url.pathname !== BIDS_PATH) {
    return withCors(json({ error: "not found" }, 404, "no-store"), origin);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "access-control-allow-methods": "GET",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== "GET") {
    return withCors(
      new Response(null, { status: 405, headers: { allow: "GET, OPTIONS" } }),
      origin,
    );
  }
  const key = new Request(`${url.origin}${BIDS_PATH}`);
  const cached = await deps.cache.match(key);
  if (cached !== undefined) return withCors(cached, origin);
  // A failure is cached as long as a sheet, so a broken RPC isn't asked again on every request.
  const response = await deps.sheet().then(
    (sheet) => json(sheet, 200, `public, max-age=${CACHE_SECONDS}`),
    (error: unknown) => {
      const reason = errorText(error);
      console.error("maker: bid sheet failed", reason);
      return json({ error: reason }, 503, `public, max-age=${CACHE_SECONDS}`);
    },
  );
  deps.waitUntil(
    deps.cache.put(key, response.clone()).catch((error: unknown) => {
      console.error("maker: couldn't cache the bid sheet", errorText(error));
    }),
  );
  return withCors(response, origin);
}
