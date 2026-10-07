import { useState } from "react";
import type { Chain } from "viem";
import type { AppConfig } from "../config.ts";
import { connect, disconnect, switchTo, type Connection, type WalletProvider } from "../wallet.ts";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function Header(props: {
  readonly config: AppConfig;
  readonly chain: Chain;
  readonly wallets: readonly WalletProvider[];
  readonly connection: Connection | null;
}) {
  const { config, chain, wallets, connection } = props;
  const [problem, setProblem] = useState<string | null>(null);

  const onConnect = (wallet: WalletProvider): void => {
    setProblem(null);
    connect(wallet).catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <header className="header">
      <h1 className="wordmark">Vayle</h1>
      <div className="wallet">
        {connection === null ? (
          wallets.length === 0 ? (
            <p className="quiet">Install a browser wallet to connect.</p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.info.uuid}
                type="button"
                onClick={() => {
                  onConnect(w);
                }}
              >
                Connect {w.info.name}
              </button>
            ))
          )
        ) : (
          <>
            {connection.chainId !== config.chainId && (
              <button
                type="button"
                onClick={() => {
                  switchTo(connection.wallet, chain).catch((error: unknown) => {
                    setProblem(error instanceof Error ? error.message : String(error));
                  });
                }}
              >
                Switch to Robinhood Chain
              </button>
            )}
            <span className="account">{short(connection.address)}</span>
            <button type="button" className="link" onClick={disconnect}>
              Disconnect
            </button>
          </>
        )}
        {problem !== null && <p className="problem">{problem}</p>}
      </div>
    </header>
  );
}
