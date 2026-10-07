import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { ogImages, rpcProxy } from "./build/plugins.ts";

// `vite --mode fork` only, and only on the dev server: stands in for the owner's disclosures so the
// ticket can be tried against a local fork. Builds never include it.
function forkDisclosures(): Plugin {
  const body = JSON.stringify([
    {
      title: "Local fork",
      body: "This app is pointed at a local fork of Robinhood Chain. Nothing here is real money, and these aren't Vayle's disclosures.",
    },
  ]);
  return {
    name: "vayle-fork-disclosures",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/disclosures.json", (_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(body);
      });
    },
  };
}

// The app's routes live under /app/ in the browser. The dev and preview servers answer any of
// them that isn't a file with the app's page, the way the deployed Worker does.
function appRoutes(): Plugin {
  const rewrite = (url: string | undefined): string | undefined => {
    if (url === undefined) return url;
    const path = url.split("?")[0] ?? url;
    const isAppRoute = path === "/app" || (path.startsWith("/app/") && !/\.[a-z0-9]+$/i.test(path));
    return isAppRoute ? "/app/index.html" : url;
  };
  return {
    name: "vayle-app-routes",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        request.url = rewrite(request.url);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((request, _response, next) => {
        request.url = rewrite(request.url);
        next();
      });
    },
  };
}

const page = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Two pages: the landing at / and the holder app at /app/. Only the app loads viem and the wallet
// libraries. In dev, /rpc forwards to the private RPC in the repo's .env, as the Worker does in
// production, so its key never reaches the page.
export default defineConfig(({ mode }) => {
  const repoEnv = loadEnv(mode, fileURLToPath(new URL("../..", import.meta.url)), "");
  return {
    plugins: [react(), appRoutes(), ogImages(), ...(mode === "fork" ? [forkDisclosures()] : [])],
    // The wallet libraries resolve viem with a different peer set than the workspace packages. One
    // copy keeps the bundle smaller and viem's error classes the same everywhere.
    resolve: { dedupe: ["viem"] },
    server: { proxy: rpcProxy(repoEnv["ROBINHOOD_RPC_URL"]) },
    preview: { proxy: rpcProxy(repoEnv["ROBINHOOD_RPC_URL"]) },
    build: {
      target: "es2022",
      sourcemap: true,
      // react-dom, viem, wagmi and the wallet modal are most of the app's first load. This warns if
      // the app's main chunk grows past what they take today.
      chunkSizeWarningLimit: 900,
      rolldownOptions: { input: { landing: page("index.html"), app: page("app/index.html") } },
    },
  };
});
