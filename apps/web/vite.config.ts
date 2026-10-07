import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

const page = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Two pages: the landing at / and the holder app at /app/. Only the app loads viem.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "fork" ? [forkDisclosures()] : [])],
  build: {
    target: "es2022",
    sourcemap: true,
    // react-dom and viem are most of the app's bundle, about 170 kB gzipped. This warns if it grows.
    chunkSizeWarningLimit: 600,
    rolldownOptions: { input: { landing: page("index.html"), app: page("app/index.html") } },
  },
}));
