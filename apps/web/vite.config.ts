import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // react-dom and viem are most of the bundle, about 170 kB gzipped. This warns if it grows.
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 600 },
});
