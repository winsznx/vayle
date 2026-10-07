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
