import "../ui/ui.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { chainOf } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { router } from "./router.tsx";
import { WalletProviders } from "./shell/WalletProviders.tsx";
import { AppProvider } from "./state.tsx";
import { walletConfigOf } from "./walletConfig.ts";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element.");

const result = loadConfig(import.meta.env);

createRoot(root).render(
  <StrictMode>
    {result.ok ? (
      <WalletProviders wagmiConfig={walletConfigOf(result.config, chainOf(result.config))}>
        <AppProvider config={result.config}>
          <RouterProvider router={router} />
        </AppProvider>
      </WalletProviders>
    ) : (
      <main className="setup">
        <h1>Vayle isn&apos;t set up</h1>
        <p>
          This build is missing settings it needs to reach the market: {result.missing.join(", ")}.
        </p>
      </main>
    )}
  </StrictMode>,
);
