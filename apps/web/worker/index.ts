import { appPage, LANDING, tabTitle, type PageMeta } from "../src/meta.ts";
import { restrictedHere, type RegionEnv } from "./region.ts";
import { proxyRpc, type RpcEnv } from "./rpc.ts";

// Serves the built site from static assets. The landing and every app route get their HTML from
// here, with that page's title, description and link preview written in, because a crawler that
// asks for /app/orders reads the HTML and never runs the app. App pages also say whether new orders
// are offered where the visitor is (region.ts). /rpc is the site's own RPC (rpc.ts). Everything
// else is a static file.

interface Env extends RpcEnv, RegionEnv {
  readonly ASSETS: Fetcher;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

function setContent(value: string): HTMLRewriterElementContentHandlers {
  return {
    element(element) {
      element.setAttribute("content", value);
    },
  };
}

function withMeta(
  html: Response,
  meta: PageMeta,
  title: string,
  url: URL,
  restricted: boolean,
): Response {
  const image = `${url.origin}/og/${meta.card}.png`;
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        if (restricted) {
          element.append('<meta name="vayle-region" content="restricted" />', { html: true });
        }
      },
    })
    .on("title", {
      element(element) {
        element.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', setContent(meta.description))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(meta.description))
    .on('meta[property="og:url"]', setContent(`${url.origin}${url.pathname}`))
    .on('meta[property="og:image"]', setContent(image))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(meta.description))
    .on('meta[name="twitter:image"]', setContent(image))
    .transform(html);
}

// A visitor's request, with what Cloudflare knows about where it came from.
type Visit = Request<unknown, IncomingRequestCfProperties>;

async function page(
  request: Visit,
  env: Env,
  shell: string,
  meta: PageMeta,
  title: string,
  status: number,
): Promise<Response> {
  const url = new URL(request.url);
  const html = await env.ASSETS.fetch(
    new Request(new URL(shell, url), { headers: request.headers }),
  );
  if (!html.ok) return html;
  const restricted = restrictedHere(request.cf?.country, request.cf?.regionCode, env);
  const body = withMeta(html, meta, title, url, restricted);
  const headers = new Headers(body.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-cache");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(body.body, { status, headers });
}

export default {
  async fetch(request: Visit, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/rpc") return proxyRpc(request, env);
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
    if (path === "/" || path === "/index.html") {
      return page(request, env, "/", LANDING, LANDING.title, 200);
    }
    if (path === "/app") return Response.redirect(`${url.origin}/app/${url.search}`, 308);
    if (path.startsWith("/app/")) {
      const inside = path.slice("/app".length).replace(/\/+$/, "") || "/";
      const { meta, found } = appPage(inside === "/index.html" ? "/" : inside);
      return page(request, env, "/app/", meta, tabTitle(meta.title), found ? 200 : 404);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
