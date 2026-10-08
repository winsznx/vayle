import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CARDS, renderCard } from "@vayle/brand/cards";
import type { Plugin, ProxyOptions } from "vite";

// The link previews, rendered from the brand's cards into og/<key>.png in every build, the way a
// framework prerenders its OG images at build time.
export function ogImages(): Plugin {
  return {
    name: "vayle-og-images",
    apply: "build",
    async generateBundle() {
      for (const card of CARDS) {
        this.emitFile({
          type: "asset",
          fileName: `og/${card.key}.png`,
          source: await renderCard(card),
        });
      }
    },
  };
}

// The asset logos, served from the brand package's pinned files at /logos/ in dev and emitted
// there in every build.
const LOGOS_DIR = fileURLToPath(new URL("../../../packages/brand/logos/", import.meta.url));
const LOGO_FILE = /^[a-z0-9]+\.(png|webp)$/;

export function tokenLogos(): Plugin {
  return {
    name: "vayle-token-logos",
    configureServer(server) {
      server.middlewares.use("/logos", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "";
        if (!LOGO_FILE.test(name)) {
          next();
          return;
        }
        res.setHeader("content-type", name.endsWith(".png") ? "image/png" : "image/webp");
        res.end(readFileSync(join(LOGOS_DIR, name)));
      });
    },
    generateBundle() {
      for (const name of readdirSync(LOGOS_DIR)) {
        if (!LOGO_FILE.test(name)) continue;
        this.emitFile({
          type: "asset",
          fileName: `logos/${name}`,
          source: readFileSync(join(LOGOS_DIR, name)),
        });
      }
    },
  };
}

// In dev and preview, /rpc forwards to the private RPC the way the deployed Worker does, so the
// key stays in the server's environment and never reaches the page.
export function rpcProxy(upstream: string | undefined): Record<string, ProxyOptions> {
  if (upstream === undefined || upstream === "") return {};
  const url = new URL(upstream);
  return {
    "/rpc": {
      target: `${url.protocol}//${url.host}`,
      changeOrigin: true,
      rewrite: () => `${url.pathname}${url.search}`,
    },
  };
}
