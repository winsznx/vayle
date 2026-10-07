import "@fontsource-variable/archivo/wdth.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadConfig } from "./config.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

const result = loadConfig(import.meta.env);

createRoot(root).render(
  <StrictMode>
    {result.ok ? (
      <App config={result.config} />
    ) : (
      <main className="setup">
        <h1>Vayle isn't set up</h1>
        <p>
          This build is missing settings it needs to reach the market: {result.missing.join(", ")}.
        </p>
      </main>
    )}
  </StrictMode>,
);
