import type { Call } from "@vayle/market";
import { useMemo, useState, useSyncExternalStore } from "react";
import { chainOf, publicClientOf } from "./chain.ts";
import { Header } from "./components/Header.tsx";
import { Ladder } from "./components/Ladder.tsx";
import { Orders } from "./components/Orders.tsx";
import { WeekLine } from "./components/WeekLine.tsx";
import { WithdrawStrip } from "./components/WithdrawStrip.tsx";
import type { AppConfig } from "./config.ts";
import { useDisclosures } from "./useDisclosures.ts";
import { useHistory } from "./useHistory.ts";
import { useMarket } from "./useMarket.ts";
import {
  connectionNow,
  send,
  subscribeConnection,
  subscribeWallets,
  walletsNow,
} from "./wallet.ts";

export type TxState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly label: string }
  | { readonly status: "done"; readonly label: string }
  | { readonly status: "failed"; readonly label: string; readonly reason: string };

export type Run = (label: string, calls: readonly Call[]) => Promise<boolean>;

export function App({ config }: { readonly config: AppConfig }) {
  const client = useMemo(() => publicClientOf(config), [config]);
  const chain = useMemo(() => chainOf(config), [config]);
  const wallets = useSyncExternalStore(subscribeWallets, walletsNow);
  const connection = useSyncExternalStore(subscribeConnection, connectionNow);
  const [version, setVersion] = useState(0);
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const owner = connection?.address ?? null;
  const { view, error } = useMarket(client, config, owner, version);
  const disclosures = useDisclosures();
  const orderIds = useMemo(() => view?.account?.orders.map((o) => o.id) ?? [], [view]);
  const history = useHistory(config.indexerUrl, orderIds);
  const onChain = connection !== null && connection.chainId === config.chainId;

  // Sends the calls one after another, each after the last confirms, then refreshes what's shown.
  const run: Run = async (label, calls) => {
    if (connection === null) return false;
    setTx({ status: "pending", label });
    try {
      for (const call of calls) {
        const hash = await send(connection, chain, call);
        await client.waitForTransactionReceipt({ hash });
      }
      setTx({ status: "done", label });
      return true;
    } catch (failure) {
      const reason =
        failure instanceof Error
          ? (failure.message.split("\n")[0] ?? failure.message)
          : String(failure);
      setTx({ status: "failed", label, reason });
      return false;
    } finally {
      setVersion((v) => v + 1);
    }
  };

  const busy = tx.status === "pending";
  return (
    <div className="app">
      <Header config={config} chain={chain} wallets={wallets} connection={connection} />
      <p className="tx" role="status" aria-live="polite">
        {tx.status === "pending" && `${tx.label}: confirm in your wallet, then wait for the chain.`}
        {tx.status === "done" && `${tx.label}: done.`}
        {tx.status === "failed" && `${tx.label} didn't go through: ${tx.reason}`}
      </p>
      {view?.account != null && onChain && (
        <WithdrawStrip config={config} account={view.account} run={run} busy={busy} />
      )}
      <main className="layout">
        <section className="week" aria-labelledby="week-heading">
          <h2 id="week-heading" className="visually-hidden">
            This week
          </h2>
          {view === null ? (
            <p className="quiet">
              {error === null ? "Reading the market." : `Can't read the market right now: ${error}`}
            </p>
          ) : (
            <>
              <WeekLine config={config} view={view} />
              <Ladder
                config={config}
                view={view}
                tradable={disclosures.status === "approved" && onChain}
                notTradableReason={
                  disclosures.status !== "approved"
                    ? "Trading opens once the disclosures are final."
                    : connection === null
                      ? "Connect a wallet to place an order."
                      : "Switch your wallet to Robinhood Chain to place an order."
                }
                run={run}
                busy={busy}
              />
            </>
          )}
        </section>
        <section className="orders" aria-labelledby="orders-heading">
          <h2 id="orders-heading">Your orders</h2>
          {connection === null ? (
            <p className="quiet">Connect a wallet to see your orders.</p>
          ) : view?.account == null ? (
            <p className="quiet">Reading your orders.</p>
          ) : (
            <Orders
              config={config}
              view={view}
              account={view.account}
              history={history}
              run={run}
              busy={busy || !onChain}
            />
          )}
        </section>
      </main>
      {disclosures.status === "approved" && (
        <footer className="disclosures">
          {disclosures.items.map((d) => (
            <section key={d.title}>
              <h3>{d.title}</h3>
              <p>{d.body}</p>
            </section>
          ))}
        </footer>
      )}
    </div>
  );
}
