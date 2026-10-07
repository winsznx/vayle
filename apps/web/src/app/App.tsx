import { withGasMargin, type Call } from "@vayle/market";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chainOf, publicClientOf } from "./chain.ts";
import { Ladder } from "./components/Ladder.tsx";
import { Orders } from "./components/Orders.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { LockedCard, WeekCard, WithdrawCard } from "./components/StatCards.tsx";
import { Ticket, TicketEmpty } from "./components/Ticket.tsx";
import { TopBar } from "./components/TopBar.tsx";
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
import { ladder } from "./week.ts";

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
  const [chosen, setChosen] = useState<bigint | null>(null);
  const ticketRef = useRef<HTMLDivElement>(null);
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
        const estimate = await client.estimateGas({
          account: connection.address,
          to: call.to,
          data: call.data,
        });
        const hash = await send(connection, chain, call, withGasMargin(estimate));
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
  const rungs = view?.epoch == null ? [] : ladder(view.epoch);
  const rung = rungs.find((r) => r.strike === chosen) ?? null;
  const tradable = config.placement && disclosures.status === "approved" && onChain;
  const notTradableReason = !config.placement
    ? "New orders aren't open yet. Existing orders can still be settled, stopped and withdrawn."
    : disclosures.status !== "approved"
      ? "Trading opens once the disclosures are final."
      : connection === null
        ? "Connect a wallet to place an order."
        : "Switch your wallet to Robinhood Chain to place an order.";

  // On narrow screens the ticket sits under the ladder, so bring it into view when a rung is picked.
  const choose = (strike: bigint): void => {
    setChosen(strike);
    if (window.matchMedia("(max-width: 1100px)").matches) {
      requestAnimationFrame(() => {
        ticketRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  return (
    <div className="frame">
      <Sidebar />
      <div className="workspace">
        <TopBar config={config} chain={chain} wallets={wallets} connection={connection} />
        {view === null ? (
          <p className="board-state" role="status">
            {error === null ? "Reading the market." : `Can't read the market right now: ${error}`}
          </p>
        ) : (
          <main className="board">
            <section className="stats" aria-label="Summary">
              <WeekCard config={config} view={view} />
              <WithdrawCard
                config={config}
                account={view.account}
                canAct={onChain}
                run={run}
                busy={busy}
              />
              <LockedCard config={config} account={view.account} />
            </section>
            <section id="trade" className="trade" aria-label="Place an order">
              <Ladder view={view} rungs={rungs} chosen={chosen} onChoose={choose} />
              <div ref={ticketRef} className="trade-side">
                {rung === null || view.epoch === null ? (
                  <TicketEmpty />
                ) : (
                  <Ticket
                    key={rung.strike.toString()}
                    config={config}
                    view={view}
                    epoch={view.epoch}
                    rung={rung}
                    rungs={rungs}
                    tradable={tradable}
                    notTradableReason={notTradableReason}
                    run={run}
                    busy={busy}
                    onPlaced={() => {
                      setChosen(null);
                    }}
                  />
                )}
              </div>
            </section>
            <section id="orders" aria-label="Your orders">
              <Orders
                config={config}
                view={view}
                account={view.account}
                history={history}
                run={run}
                busy={busy || !onChain}
              />
            </section>
            {disclosures.status === "approved" && (
              <footer className="disclosures">
                {disclosures.items.map((d) => (
                  <section key={d.title}>
                    <h3 className="disclosure-title">{d.title}</h3>
                    <p>{d.body}</p>
                  </section>
                ))}
              </footer>
            )}
          </main>
        )}
      </div>
      <div className="toast-region" role="status" aria-live="polite">
        {tx.status !== "idle" && (
          <p className={`toast toast-${tx.status}`}>
            {tx.status === "pending" &&
              `${tx.label}: confirm in your wallet, then wait for the chain.`}
            {tx.status === "done" && `${tx.label}: done.`}
            {tx.status === "failed" && `${tx.label} didn't go through: ${tx.reason}`}
          </p>
        )}
      </div>
    </div>
  );
}
