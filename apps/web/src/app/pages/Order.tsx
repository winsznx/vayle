import "./order.css";
import type { MarketEvent, OrderState, OrderSummary } from "@vayle/market";
import { useId, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CASH_SYMBOL } from "../../tokens.ts";
import { TokenLogo } from "../../ui/TokenLogo.tsx";
import { marketOfToken } from "../assets.ts";
import { HistoryNote } from "../components/HistoryNote.tsx";
import { EditOrder } from "../components/EditOrder.tsx";
import { actionFor, lineOf, OrderBadge, Ticks } from "../components/Orders.tsx";
import type { AppConfig } from "../config.ts";
import { contextOf, describeEvent, txUrl, type EventLine } from "../events.ts";
import { amountOf, dollars, easternTime, premium, unitOf, usdgAmount } from "../format.ts";
import { nameOf, type OrderLine } from "../orders.ts";
import { EXTERNAL_ICON, NavIcon } from "../shell/nav.tsx";
import { useApp } from "../state.tsx";
import type { MarketHistory } from "../useMarketHistory.ts";

// One target: the price it holds, its terms, what it has earned, and everything that happened to it.

const BACK_ICON = "M11 4.5 6.5 9l4.5 4.5";

type Waiting = Exclude<MarketHistory["status"], "ready">;

const EARNINGS_WAIT: Readonly<Record<Waiting, string>> = {
  idle: "Connect a wallet to see what this target has earned.",
  off: "This build doesn't read history, so earnings aren't shown.",
  loading: "Earnings show once the history is read.",
  failed: "Earnings can't be shown while history is unavailable.",
};

const HISTORY_WAIT: Readonly<Record<Waiting, string>> = {
  idle: "Connect a wallet to see this target's history.",
  off: "This build doesn't read history.",
  loading: "Reading this target's history.",
  failed: "History is unavailable right now.",
};

const WHOLE_NUMBER = /^\d+$/;

interface LastSet {
  readonly size: bigint;
  readonly changed: boolean;
}

// The target number in the URL, when it's a whole number.
function idOf(param: string | undefined): bigint | null {
  return param !== undefined && WHOLE_NUMBER.test(param) ? BigInt(param) : null;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function Term(props: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd className={props.className}>{props.children}</dd>
    </div>
  );
}

// How a closed target ended, from its history: the fill that closed it, with when, or null when
// it ended some other way or the history isn't read.
function filledLine(history: MarketHistory, id: string, line: OrderLine): string | null {
  if (history.status !== "ready") return null;
  const fill = history.events.findLast(
    (e) =>
      e.name === "OrderSettled" &&
      e.order_id === id &&
      typeof e.args["proceeds"] === "string" &&
      e.args["proceeds"] !== "0",
  );
  if (fill === undefined) return null;
  const when = easternTime(Math.floor(Date.parse(fill.block_time) / 1000));
  return line.side === "sell"
    ? `Sold at your price on ${when}.`
    : `Bought at your price on ${when}.`;
}

function OrderHead({
  order,
  line,
  ended,
}: {
  readonly order: OrderState;
  readonly line: OrderLine;
  readonly ended: string | null;
}) {
  const { config, run, busy, onChain } = useApp();
  const noteId = useId();
  const action = actionFor(config, order, line);
  return (
    <section className="card od-head">
      <div className="od-head-top">
        <div className="od-ident">
          <OrderBadge config={config} order={order} size="xl" />
          <h2 className="od-title">
            <span className="od-title-lead">{nameOf(line)} at</span>{" "}
            <span className="od-title-price num">{line.price}</span>
          </h2>
        </div>
        <span className={`chip chip-${line.chip.tone}`}>{line.chip.label}</span>
      </div>
      <div className="od-head-foot">
        <p className="od-status">
          {order.status === "closed" && ended !== null ? ended : line.status}
        </p>
        {action !== null && (
          <button
            type="button"
            className={action.quiet ? "btn btn-outline" : "btn btn-ink"}
            disabled={busy || !onChain}
            aria-describedby={onChain ? undefined : noteId}
            onClick={() => void run(action.label, action.calls)}
          >
            {action.label}
          </button>
        )}
        {action !== null && !onChain && (
          <p id={noteId} className="od-act-note">
            Switch your wallet to Robinhood Chain first.
          </p>
        )}
      </div>
    </section>
  );
}

// The size the target was last given, by its placement or its latest change, for a target that has
// none left.
function lastSetSizeOf(history: MarketHistory, id: string): LastSet | null {
  if (history.status !== "ready") return null;
  const set = history.events.findLast(
    (e) => (e.name === "OrderPlaced" || e.name === "OrderAmended") && e.order_id === id,
  );
  const size = set?.args["size"];
  if (set === undefined || typeof size !== "string" || !/^\d+$/.test(size)) return null;
  return { size: BigInt(size), changed: set.name === "OrderAmended" };
}

function OrderTerms(props: {
  readonly config: AppConfig;
  readonly order: OrderState;
  readonly line: OrderLine;
  // The size the target was last given, for a target that has none left.
  readonly lastSet: LastSet | null;
}) {
  const { config, order, line, lastSet } = props;
  const market = marketOfToken(config.markets, order.asset);
  const symbol = market?.symbol ?? "token";
  // A target on a market the build doesn't list shows its token's raw units.
  const amount = (raw: bigint): string =>
    market === undefined ? `${raw.toString()} raw units` : amountOf(raw, unitOf(market));
  const price = (units: bigint): string => dollars(units, config.usdgDecimals);
  const selling = line.side === "sell";
  let afterFill = "It stops";
  if (order.flip) {
    afterFill = selling
      ? `Sets a buy target at ${price(order.flipTarget)}`
      : `Sets a sell target at ${price(order.flipTarget)}`;
  }
  return (
    <section className="card od-terms">
      <div className="card-head">
        <h2 className="h3">Terms</h2>
      </div>
      <dl className="od-dl">
        <Term label="Kind">{line.kind}</Term>
        <Term label="Stock Token">{market?.symbol ?? order.asset}</Term>
        <Term label="Price" className="od-price num">
          {price(order.target)}
        </Term>
        <Term label="Size" className="num">
          {order.size > 0n
            ? amount(order.size)
            : lastSet === null
              ? "Nothing left"
              : `${amount(lastSet.size)} when ${lastSet.changed ? "last changed" : "placed"}`}
        </Term>
        <Term label="In this week's trade" className="num">
          {order.committed > 0n
            ? amount(order.committed)
            : order.status === "active"
              ? "Nothing yet"
              : "Nothing"}
        </Term>
        <Term label="Least payment each week">
          <span className="num">
            {premium(order.minPremium, config.usdgDecimals)} per {symbol}
          </span>
          <span className="od-help">
            A week that bids less than this is skipped, and your target carries over.
          </span>
        </Term>
        <Term label={selling ? "When it sells" : "When it buys"}>{afterFill}</Term>
        <Term label="Target number" className="num">
          {order.id.toString()}
        </Term>
      </dl>
    </section>
  );
}

function EarningsBody({
  config,
  summary,
}: {
  readonly config: AppConfig;
  readonly summary: OrderSummary;
}) {
  const earned = BigInt(summary.premiumEarned);
  return (
    <dl className="od-tallies">
      <Term label="Earned" className={earned > 0n ? "od-tally od-tally-paid" : "od-tally"}>
        <TokenLogo symbol={CASH_SYMBOL} size="md" />
        <span className="num">{usdgAmount(earned, config.usdgDecimals)}</span>
      </Term>
      <Term label="Weeks paid" className="od-tally">
        <span className="num">{summary.weeksFilled}</span>
        <Ticks summary={{ ...summary, skipStreak: 0 }} />
      </Term>
      <Term label="Skipped in a row" className="od-tally">
        <span className="num">{summary.skipStreak}</span>
        <Ticks summary={{ ...summary, weeksFilled: 0 }} />
      </Term>
    </dl>
  );
}

function OrderEarnings(props: {
  readonly config: AppConfig;
  readonly history: MarketHistory;
  readonly id: string;
}) {
  const { config, history, id } = props;
  let body: ReactNode;
  if (history.status !== "ready") {
    body = <p className="empty-state">{EARNINGS_WAIT[history.status]}</p>;
  } else {
    const summary = history.summaries.get(id);
    body =
      summary === undefined ? (
        <p className="empty-state">This target isn&apos;t in the history yet.</p>
      ) : (
        <EarningsBody config={config} summary={summary} />
      );
  }
  return (
    <section className="card od-earnings">
      <div className="card-head">
        <div>
          <h2 className="h3">Earnings</h2>
          <p className="card-sub">What the maker Vayle operates has paid this target.</p>
        </div>
      </div>
      {body}
    </section>
  );
}

function EventItem(props: {
  readonly config: AppConfig;
  readonly event: MarketEvent;
  readonly line: EventLine;
  readonly id: string;
}) {
  const { config, event, line, id } = props;
  const seconds = Date.parse(event.block_time) / 1000;
  const url = txUrl(config, event.tx_hash);
  // A flip joins two targets, so its entry links to the one this page isn't showing.
  const toId = event.args["toId"];
  const other =
    event.name !== "OrderFlipped"
      ? null
      : event.order_id === id
        ? typeof toId === "string"
          ? toId
          : null
        : event.order_id;
  // What happened comes first for anyone reading in order. The layout puts when and which
  // transaction in a column of their own.
  return (
    <li className="od-event">
      <div className="od-event-main">
        <p className="od-event-title">{line.title}</p>
        {line.detail !== null && <p className="od-event-detail">{line.detail}</p>}
        {other !== null && (
          <Link className="od-event-link" to={`/orders/${other}`}>
            See target {other}
          </Link>
        )}
      </div>
      {line.amount !== null && (
        <p
          className={
            line.kind === "earned" ? "od-event-amount od-amount-paid num" : "od-event-amount num"
          }
        >
          {line.amount}
        </p>
      )}
      <div className="od-event-meta">
        <time className="od-event-time" dateTime={event.block_time}>
          {Number.isFinite(seconds) ? easternTime(seconds) : event.block_time}
        </time>
        {url === null ? (
          <p className="od-event-tx num" title={event.tx_hash}>
            <span className="visually-hidden">Transaction </span>
            {shortHash(event.tx_hash)}
          </p>
        ) : (
          <a
            className="od-event-tx od-event-tx-link num"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            <span className="visually-hidden">Transaction </span>
            {shortHash(event.tx_hash)}
            <span className="visually-hidden"> (opens in a new tab)</span>
            <NavIcon d={EXTERNAL_ICON} />
          </a>
        )}
      </div>
    </li>
  );
}

function OrderHistory(props: {
  readonly config: AppConfig;
  readonly history: MarketHistory;
  readonly id: string;
}) {
  const { config, history, id } = props;
  const items: { readonly event: MarketEvent; readonly line: EventLine }[] = [];
  if (history.status === "ready") {
    const context = contextOf(history.events, config.markets);
    const own = history.events.filter(
      (e) => e.order_id === id || (e.name === "OrderFlipped" && e.args["toId"] === id),
    );
    for (const event of own.reverse()) {
      const line = describeEvent(event, config, context);
      if (line !== null) items.push({ event, line });
    }
  }
  return (
    <section className="card od-history">
      <div className="card-head">
        <div>
          <h2 className="h3">History</h2>
          <p className="card-sub">Newest first.</p>
        </div>
        {items.length > 0 && (
          <span className="card-count num">
            {items.length}
            <span className="visually-hidden"> events</span>
          </span>
        )}
      </div>
      {history.status !== "ready" ? (
        <p className="empty-state">{HISTORY_WAIT[history.status]}</p>
      ) : items.length === 0 ? (
        <p className="empty-state">Nothing has happened to this target yet.</p>
      ) : (
        <ol className="od-events">
          {items.map(({ event, line }) => (
            <EventItem
              key={`${event.block_number}:${event.log_index}`}
              config={config}
              event={event}
              line={line}
              id={id}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

export function OrderPage(): ReactNode {
  const { id: param } = useParams();
  const { config, view, wallet, history } = useApp();
  if (view === null) return null;
  const id = idOf(param);
  const account = view.account;
  const order =
    account === null || id === null ? undefined : account.orders.find((o) => o.id === id);

  let body: ReactNode;
  if (account === null) {
    body =
      wallet.address === null ? (
        <section className="card notice-card">
          <h2 className="h3">Wallet not connected</h2>
          <p className="muted">Connect the wallet that set this target to see it.</p>
        </section>
      ) : (
        <p className="muted" role="status">
          Reading this wallet&apos;s targets.
        </p>
      );
  } else if (order === undefined) {
    body = (
      <section className="card notice-card">
        <h2 className="h3">Target not found</h2>
        <p className="muted">This target isn&apos;t one of this wallet&apos;s.</p>
      </section>
    );
  } else {
    const line = lineOf(config, view, account, order);
    const key = order.id.toString();
    body = (
      <>
        <OrderHead order={order} line={line} ended={filledLine(history, key, line)} />
        <div className="od-body">
          <div className="od-layout">
            <OrderEarnings config={config} history={history} id={key} />
            <div className="od-side">
              <OrderTerms
                config={config}
                order={order}
                line={line}
                lastSet={lastSetSizeOf(history, key)}
              />
              <EditOrder order={order} />
            </div>
            <OrderHistory config={config} history={history} id={key} />
          </div>
        </div>
        <HistoryNote />
      </>
    );
  }

  return (
    <>
      <Link className="od-back" to="/orders">
        <NavIcon d={BACK_ICON} />
        All targets
      </Link>
      {body}
    </>
  );
}
