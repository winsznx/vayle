import type { MarketEvent, OrderState } from "@vayle/market";
import { formatFixed } from "@vayle/units";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { TokenIcon } from "../../ui/TokenIcon.tsx";
import { actionFor, lineOf, type Action } from "../components/Orders.tsx";
import { LockedCard, WeekCard, WithdrawCard } from "../components/StatCards.tsx";
import type { AppConfig } from "../config.ts";
import { describeEvent, sidesOf, txUrl, type EventLine } from "../events.ts";
import { dollars, easternTime, premium, usdgAmount } from "../format.ts";
import type { OrderLine } from "../orders.ts";
import { useApp, type Run } from "../state.tsx";
import type { AccountView, MarketView } from "../useMarket.ts";
import type { MarketHistory } from "../useMarketHistory.ts";
import { ladder, type Rung } from "../week.ts";
import "./overview.css";

// The holder's home: what needs them, what they hold in orders, what those orders have earned, and
// where this week stands. Everything shown comes from the shared market read or the holder's history.

const SHOWN_ORDERS = 4;
const SHOWN_EVENTS = 5;
const RUNGS_EACH_SIDE = 3;

interface Entry {
  readonly order: OrderState;
  readonly line: OrderLine;
}

interface Needed extends Entry {
  readonly action: Action;
}

interface Happened {
  readonly event: MarketEvent;
  readonly line: EventLine;
}

type PendingHistory = Exclude<MarketHistory, { readonly status: "ready" }>;

function newestFirst(a: Entry, b: Entry): number {
  if (a.order.id === b.order.id) return 0;
  return a.order.id < b.order.id ? 1 : -1;
}

function nameOf(line: OrderLine): string {
  return line.title.replace(/ at$/, "");
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

function priceKey(side: Rung["side"], strike: bigint): string {
  return `${side}:${strike.toString()}`;
}

// The prices the holder's active orders stand at, so the week's prices can mark them as theirs.
function heldPrices(account: AccountView): Set<string> {
  return new Set(
    account.orders
      .filter((o) => o.status === "active")
      .map((o) => priceKey(o.side === 0 ? "sell" : "buy", o.target)),
  );
}

// Errors from the chain client run on for lines of request detail. The first line says what failed.
function firstLine(message: string): string {
  return message.split("\n")[0] ?? message;
}

function historyState(history: PendingHistory): string {
  switch (history.status) {
    case "idle":
      return "Connect a wallet to see your history.";
    case "off":
      return "History isn't shown in this build. It has no indexer and no deploy block to read from.";
    case "loading":
      return history.source === "indexer"
        ? "Loading your history from the indexer."
        : "Reading your history from the chain. The first read goes back to the market's deploy.";
    case "failed":
      return `History is unavailable right now: ${firstLine(history.reason)}`;
  }
}

// The same states, short enough for a summary card.
function earnedState(history: PendingHistory): string {
  switch (history.status) {
    case "idle":
      return "Connect a wallet to see what your orders earned.";
    case "off":
      return "This build doesn't read history, so earnings aren't added up.";
    case "loading":
      return history.source === "indexer"
        ? "Adding up your premiums from the indexer."
        : "Adding up your premiums from the chain.";
    case "failed":
      return "History is unavailable right now, so earnings can't be added up.";
  }
}

function recentOf(events: readonly MarketEvent[], config: AppConfig): Happened[] {
  const sideOf = sidesOf(events);
  return [...events]
    .reverse()
    .flatMap((event) => {
      const line = describeEvent(event, config, sideOf);
      return line === null ? [] : [{ event, line }];
    })
    .slice(0, SHOWN_EVENTS);
}

export function OverviewPage(): ReactNode {
  const { config, view, wallet, onChain, history, run, busy, readError } = useApp();
  if (view === null) return null;

  if (wallet.address === null) {
    return (
      <div className="ov-intro">
        <section className="card notice-card ov-welcome">
          <h2 className="h3">Your paid limit orders, in one place</h2>
          <p className="ov-welcome-line">
            Connect a wallet to see your orders, what they&apos;ve earned and what&apos;s ready to
            withdraw.
          </p>
          <Link className="btn btn-ink" to="/trade">
            See this week&apos;s prices
          </Link>
        </section>
        <WeekCard config={config} view={view} />
      </div>
    );
  }

  const account = view.account;
  if (account === null) {
    return (
      <div className="ov-intro">
        <section className="card notice-card ov-welcome" role="status">
          <h2 className="h3">Your orders</h2>
          <p className="ov-welcome-line ov-state">
            {readError === null
              ? "Reading your orders from the chain."
              : `Can't read your orders right now: ${firstLine(readError)}`}
          </p>
        </section>
        <WeekCard config={config} view={view} />
      </div>
    );
  }

  const entries = account.orders
    .map((order) => ({ order, line: lineOf(config, view, account, order) }))
    .sort(newestFirst);
  const needed = entries.flatMap((entry): Needed[] => {
    if (entry.line.action !== "settle" && entry.line.action !== "finalize-then-settle") return [];
    const action = actionFor(config, entry.order, entry.line);
    return action === null ? [] : [{ ...entry, action }];
  });
  const open = entries.filter(({ order }) => order.status === "active" || order.series !== 0n);

  return (
    <>
      <div className="ov-stats">
        <WeekCard config={config} view={view} />
        <WithdrawCard config={config} account={account} canAct={onChain} run={run} busy={busy} />
        <LockedCard config={config} account={account} />
        <EarnedCard config={config} history={history} />
      </div>
      <NeedsYou items={needed} canAct={onChain} run={run} busy={busy} />
      <div className="ov-columns">
        <YourOrders entries={open.slice(0, SHOWN_ORDERS)} total={account.orders.length} />
        <RecentActivity config={config} history={history} />
      </div>
      <WeekPrices config={config} view={view} held={heldPrices(account)} />
    </>
  );
}

// Every premium the holder's orders have taken, added up from the same history the order pages read.
function EarnedCard({
  config,
  history,
}: {
  readonly config: AppConfig;
  readonly history: MarketHistory;
}) {
  if (history.status !== "ready") {
    return (
      <article className="card stat">
        <p className="stat-title">Earned so far</p>
        <p className="stat-empty ov-state">{earnedState(history)}</p>
      </article>
    );
  }
  const summaries = [...history.summaries.values()];
  const earned = summaries.reduce((sum, s) => sum + BigInt(s.premiumEarned), 0n);
  const weeks = summaries.reduce((sum, s) => sum + s.weeksFilled, 0);
  const source = history.source === "indexer" ? "the indexer" : "the chain";
  return (
    <article className="card stat">
      <p className="stat-title">Earned so far</p>
      {summaries.length === 0 ? (
        <p className="stat-empty">Nothing yet. What your orders earn adds up here.</p>
      ) : (
        <>
          <p className="ov-amount">
            <TokenIcon symbol="USDG" size="md" />
            <span className="amount num">{usdgAmount(earned, config.usdgDecimals)}</span>
          </p>
          <p className="ov-weeks">
            {plural(weeks, "paid week")} across {plural(summaries.length, "order")}
          </p>
        </>
      )}
      <div className="ov-sources">
        {summaries.length > 0 && <p className="stat-caption">From the team-operated maker</p>}
        <p className="stat-caption">
          {history.toBlock > 0n
            ? `As of block ${history.toBlock.toString()}, from ${source}`
            : `From ${source}`}
        </p>
        {history.problem !== null && <p className="stat-caption">The latest refresh failed</p>}
      </div>
    </article>
  );
}

// A card's title, the line under it when there is one, and what the card leads to.
function CardHead({
  title,
  sub,
  aside,
}: {
  readonly title: string;
  readonly sub: string | null;
  readonly aside: ReactNode;
}) {
  return (
    <div className="card-head ov-head">
      <h2 className="h3">{title}</h2>
      {sub !== null && <p className="card-sub">{sub}</p>}
      <div className="ov-head-aside">{aside}</div>
    </div>
  );
}

function NeedsYou({
  items,
  canAct,
  run,
  busy,
}: {
  readonly items: readonly Needed[];
  readonly canAct: boolean;
  readonly run: Run;
  readonly busy: boolean;
}) {
  if (items.length === 0) {
    return (
      <section className="card ov-needs-none">
        <h2 className="ov-needs-heading">Needs you</h2>
        <p className="ov-needs-line">Nothing needs you right now.</p>
        <Link className="ov-link" to="/orders">
          See your orders
        </Link>
      </section>
    );
  }
  return (
    <section className="card ov-needs">
      <CardHead
        title="Needs you"
        sub={
          canAct
            ? "These weeks have ended. Settle each one to collect its result."
            : "Switch your wallet to Robinhood Chain to settle."
        }
        aside={
          <span className="card-count num">
            {items.length}
            <span className="visually-hidden"> to settle</span>
          </span>
        }
      />
      <ul className="ov-list ov-need-list">
        {items.map(({ order, line, action }) => (
          <li key={order.id.toString()} className="ov-need">
            <Link className="ov-name" to={`/orders/${order.id.toString()}`}>
              <TokenIcon symbol="NVDA" size="md" />
              <span className="ov-name-text">{nameOf(line)}</span>
            </Link>
            <span className="ov-price num">{line.price}</span>
            <p className="ov-need-status">{line.status}</p>
            <button
              type="button"
              className="btn btn-ink btn-sm ov-need-action"
              aria-label={`${action.label} ${nameOf(line)} at ${line.price}`}
              disabled={busy || !canAct}
              onClick={() => void run(action.label, action.calls)}
            >
              {action.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function YourOrders({
  entries,
  total,
}: {
  readonly entries: readonly Entry[];
  readonly total: number;
}) {
  return (
    <section className="card ov-panel">
      <CardHead
        title="Your orders"
        sub={null}
        aside={
          <Link className="ov-link" to="/orders" aria-label={`All orders, ${total} in total`}>
            All orders
            <span className="ov-count num">{total}</span>
          </Link>
        }
      />
      {entries.length === 0 ? (
        <p className="empty-state">
          No open orders.{" "}
          <Link className="ov-link" to="/trade">
            Choose a price
          </Link>{" "}
          to place one.
        </p>
      ) : (
        <ul className="ov-list ov-order-list">
          {entries.map(({ order, line }) => (
            <li key={order.id.toString()}>
              <Link className="ov-order" to={`/orders/${order.id.toString()}`}>
                <span className="ov-name">
                  <TokenIcon symbol="NVDA" size="md" />
                  <span className="ov-name-text">{nameOf(line)}</span>
                </span>
                <span className="ov-price num">{line.price}</span>
                <span className={`chip chip-${line.chip.tone}`}>{line.chip.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// When it happened, linked to the transaction when the build knows an explorer. The cell always
// renders, so the amounts beside it stay in their column.
function EventTime({ config, event }: { readonly config: AppConfig; readonly event: MarketEvent }) {
  const seconds = Math.floor(Date.parse(event.block_time) / 1000);
  if (!Number.isFinite(seconds)) return <p className="ov-event-time" />;
  const time = <time dateTime={event.block_time}>{easternTime(seconds)}</time>;
  const url = txUrl(config, event.tx_hash);
  return <p className="ov-event-time">{url === null ? time : <a href={url}>{time}</a>}</p>;
}

function RecentActivity({
  config,
  history,
}: {
  readonly config: AppConfig;
  readonly history: MarketHistory;
}) {
  const recent = history.status === "ready" ? recentOf(history.events, config) : [];
  const premiums = recent.some(({ line }) => line.kind === "earned");
  return (
    <section className="card ov-panel">
      <CardHead
        title="Recent activity"
        sub={premiums ? "Premiums come from the team-operated maker." : null}
        aside={
          <Link className="ov-link" to="/activity">
            All activity
          </Link>
        }
      />
      {history.status !== "ready" ? (
        <p className="empty-state ov-state">{historyState(history)}</p>
      ) : recent.length === 0 ? (
        <p className="empty-state">Nothing has happened on your orders yet.</p>
      ) : (
        <ol className="ov-list ov-event-list">
          {recent.map(({ event, line }) => (
            <li key={`${event.block_number}:${event.log_index}`} className="ov-event">
              <p className="ov-event-title">{line.title}</p>
              <EventTime config={config} event={event} />
              {line.amount !== null && (
                <p
                  className={
                    line.kind === "earned"
                      ? "ov-event-amount ov-event-earned num"
                      : "ov-event-amount num"
                  }
                >
                  {line.amount}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {history.status === "ready" && history.problem !== null && (
        <p className="ov-foot">
          The latest refresh failed, so this is as of block {history.toBlock.toString()}.
        </p>
      )}
    </section>
  );
}

function RungLink({
  config,
  rung,
  bid,
  mine,
}: {
  readonly config: AppConfig;
  readonly rung: Rung;
  readonly bid: bigint | undefined;
  readonly mine: boolean;
}) {
  const selling = rung.side === "sell";
  return (
    <li>
      <Link
        className={mine ? "ov-rung ov-rung-mine" : "ov-rung"}
        to={`/trade?price=${formatFixed(rung.strike, config.usdgDecimals)}`}
      >
        <span className="ov-rung-tags">
          <span className={selling ? "row-side side-sell" : "row-side side-buy"}>
            {selling ? "Sell" : "Buy"}
          </span>
          {mine && <span className="ov-mine">Your price</span>}
        </span>
        <span className="ov-rung-price num">{dollars(rung.strike)}</span>
        <span className="ov-rung-bid">
          {bid === undefined ? (
            "No bid yet"
          ) : (
            <>
              Bid <span className="ov-bid num">{premium(bid)}</span>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

// The prices either side of the close, highest first as on the ladder, each a way into the ticket.
function WeekPrices({
  config,
  view,
  held,
}: {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly held: ReadonlySet<string>;
}) {
  const e = view.epoch;
  const rungs = e === null ? [] : ladder(e);
  const sells = rungs.filter((r) => r.side === "sell").slice(-RUNGS_EACH_SIDE);
  const buys = rungs.filter((r) => r.side === "buy").slice(0, RUNGS_EACH_SIDE);
  const link = (rung: Rung) => (
    <RungLink
      key={rung.strike.toString()}
      config={config}
      rung={rung}
      bid={view.bids.get(rung.strike)}
      mine={held.has(priceKey(rung.side, rung.strike))}
    />
  );
  return (
    <section className="card ov-prices">
      <CardHead
        title="This week's prices"
        sub={`Nearest the close, with the team-operated maker's bid per ${config.assetSymbol}.`}
        aside={
          <Link className="ov-link" to="/trade">
            Open the ladder
          </Link>
        }
      />
      {e === null ? (
        <p className="empty-state">The ladder opens at the next weekly close.</p>
      ) : (
        <ol className="ov-rungs">
          {sells.map(link)}
          <li className="ov-close">
            <span className="close-pill num">Close {dollars(e.referencePrice)}</span>
          </li>
          {buys.map(link)}
        </ol>
      )}
    </section>
  );
}
