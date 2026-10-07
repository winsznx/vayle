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

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "fork" ? [forkDisclosures()] : [])],
  // react-dom and viem are most of the bundle, about 170 kB gzipped. This warns if it grows.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 600 },
}));
