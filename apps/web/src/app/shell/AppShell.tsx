import type { ReactNode } from "react";
import { Link, Outlet, useMatches, useRouteError } from "react-router";
import { Sidebar } from "../components/Sidebar.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { txUrl } from "../events.ts";
import { easternTime } from "../format.ts";
import { useApp, type TxState } from "../state.tsx";
import type { MarketView } from "../useMarket.ts";
import { PhoneTabs } from "./PhoneTabs.tsx";

// Each route names itself in its handle; the shell shows it in the top bar and the tab title.
export interface RouteHandle {
  readonly title: string;
}

function isRouteHandle(value: unknown): value is RouteHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { title?: unknown }).title === "string"
  );
}

function usePageTitle(): string {
  const matches = useMatches();
  for (const match of [...matches].reverse()) {
    if (isRouteHandle(match.handle)) return match.handle.title;
  }
  return "Vayle";
}

function Toast({ tx }: { readonly tx: TxState }) {
  const { config } = useApp();
  if (tx.status === "idle")
    return <div className="toast-region" role="status" aria-live="polite" />;
  const steps = (step: number, total: number): string =>
    total > 1 ? ` (${step} of ${total})` : "";
  const link = (hash: string | null): ReactNode => {
    const url = hash === null ? null : txUrl(config, hash);
    return url === null ? null : (
      <a className="toast-link" href={url} target="_blank" rel="noreferrer">
        View transaction
      </a>
    );
  };
  return (
    <div className="toast-region" role="status" aria-live="polite">
      <p className={`toast toast-${tx.status}`}>
        {tx.status === "signing" &&
          `${tx.label}${steps(tx.step, tx.steps)}: confirm it in your wallet.`}
        {tx.status === "confirming" && (
          <>
            {`${tx.label}${steps(tx.step, tx.steps)}: sent, waiting for the chain. `}
            {link(tx.hash)}
          </>
        )}
        {tx.status === "done" && (
          <>
            {`${tx.label}: done. `}
            {link(tx.hash)}
          </>
        )}
        {tx.status === "failed" && `${tx.label} didn't go through. ${tx.reason}`}
      </p>
    </div>
  );
}

function Frame({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const { tx } = useApp();
  return (
    <div className="frame">
      <title>{`${title} | Vayle`}</title>
      <Sidebar />
      <div className="workspace">
        <TopBar title={title} />
        {children}
      </div>
      <PhoneTabs />
      <Toast tx={tx} />
    </div>
  );
}

const TICKERS = new Intl.ListFormat("en-US", { type: "conjunction" });

// A halt or a pause changes what every page can do, so it's said above every page while it lasts.
function MarketNotice({ view }: { readonly view: MarketView }) {
  if (view.now < view.haltedUntil) {
    return (
      <p className="market-notice market-notice-halted" role="status">
        The market is halted until {easternTime(view.haltedUntil)}. Nothing can be set, changed,
        settled or withdrawn until then.
      </p>
    );
  }
  if (view.paused) {
    return (
      <p className="market-notice" role="status">
        New targets are paused. Settling, stopping and withdrawing still work.
      </p>
    );
  }
  const paused = view.assets.filter((a) => a.paused).map((a) => a.market.symbol);
  if (paused.length > 0) {
    return (
      <p className="market-notice" role="status">
        New {TICKERS.format(paused)} targets are paused. Settling, stopping and withdrawing still
        work.
      </p>
    );
  }
  return null;
}

export function AppShell() {
  const { view, readError } = useApp();
  const title = usePageTitle();
  return (
    <Frame title={title}>
      {view === null ? (
        <p className="board-state" role="status">
          {readError === null
            ? "Reading the market."
            : `Can't read the market right now: ${readError}`}
        </p>
      ) : (
        <main className="board">
          <MarketNotice view={view} />
          <Outlet />
        </main>
      )}
    </Frame>
  );
}

// A route that threw: say so, keep the frame, and offer a way back.
export function RouteError() {
  const error = useRouteError();
  const message = error instanceof Error ? error.message : "Something went wrong on this page.";
  return (
    <Frame title="Something went wrong">
      <main className="board">
        <section className="card notice-card">
          <h2 className="h3">This page couldn&apos;t load</h2>
          <p className="muted">{message}</p>
          <Link className="btn btn-ink" to="/">
            Go to the overview
          </Link>
        </section>
      </main>
    </Frame>
  );
}
