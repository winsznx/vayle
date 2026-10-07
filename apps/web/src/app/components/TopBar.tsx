import { useState } from "react";
import type { Chain } from "viem";
import { BrandMark } from "../../ui/BrandMark.tsx";
import { ThemeToggle } from "../../ui/ThemeToggle.tsx";
import type { AppConfig } from "../config.ts";
import { connect, disconnect, switchTo, type Connection, type WalletProvider } from "../wallet.ts";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function TopBar(props: {
  readonly config: AppConfig;
  readonly chain: Chain;
  readonly wallets: readonly WalletProvider[];
  readonly connection: Connection | null;
}) {
  const { config, chain, wallets, connection } = props;
  const [problem, setProblem] = useState<string | null>(null);
  const report = (error: unknown): void => {
    setProblem(error instanceof Error ? error.message : String(error));
  };

  return (
    <header className="topbar">
      <a className="topbar-brand" href="/" aria-label="Vayle home">
        <BrandMark />
      </a>
      <h1 className="topbar-title h2">This week</h1>
      <div className="topbar-actions">
        <ThemeToggle />
        {connection === null ? (
          wallets.length === 0 ? (
            <span className="quiet-note">Install a browser wallet to connect</span>
          ) : (
            wallets.map((w) => (
              <button
                key={w.info.uuid}
                type="button"
                className="btn btn-ink"
                onClick={() => {
                  setProblem(null);
                  connect(w).catch(report);
                }}
              >
                <img className="wallet-icon" src={w.info.icon} alt="" width={20} height={20} />
                Connect {w.info.name}
              </button>
            ))
          )
        ) : (
          <>
            {connection.chainId !== config.chainId && (
              <button
                type="button"
                className="btn btn-brand"
                onClick={() => {
                  switchTo(connection.wallet, chain).catch(report);
                }}
              >
                Switch to Robinhood Chain
              </button>
            )}
            <span className="account-pill">
              <img
                className="wallet-icon"
                src={connection.wallet.info.icon}
                alt=""
                width={20}
                height={20}
              />
              <span className="num">{short(connection.address)}</span>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label="Disconnect"
              onClick={disconnect}
            >
              <svg className="nav-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
                <path d="M7.5 3.5H5A1.5 1.5 0 0 0 3.5 5v8A1.5 1.5 0 0 0 5 14.5h2.5M11.5 12.5 15 9l-3.5-3.5M15 9H7.5" />
              </svg>
              <span className="btn-label">Disconnect</span>
            </button>
          </>
        )}
      </div>
      {problem !== null && (
        <p className="topbar-problem" role="alert">
          {problem}
        </p>
      )}
    </header>
  );
}
