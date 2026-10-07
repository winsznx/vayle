import "./activity.css";
import type { MarketEvent } from "@vayle/market";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { Link, useSearchParams } from "react-router";
import { HistoryNote } from "../components/HistoryNote.tsx";
import type { AppConfig } from "../config.ts";
import { describeEvent, sidesOf, txUrl, type EventKind, type EventLine } from "../events.ts";
import { easternClock } from "../format.ts";
import { EXTERNAL_ICON, NavIcon } from "../shell/nav.tsx";
import { useApp } from "../state.tsx";

// Everything that happened on the holder's orders and balances, by Eastern day, newest first. The
// filter lives in the URL, ?show=earnings, so a filtered view can be linked to.

type Show = "all" | "earnings" | "fills" | "orders" | "wallet";

interface Tab {
  readonly key: Show;
  readonly label: string;
  // The kind of event the tab lists. Null lists every kind.
  readonly kind: EventKind | null;
  readonly empty: string;
}

const ALL: Tab = {
  key: "all",
  label: "All",
  kind: null,
  empty:
    "No activity yet. Orders you place, the premiums they earn and what you withdraw show up here.",
};

const TABS: readonly Tab[] = [
  ALL,
  {
    key: "earnings",
    label: "Earnings",
    kind: "earned",
    empty: "No premiums yet. When an order earns a week's premium, it shows up here.",
  },
  {
    key: "fills",
    label: "Fills",
    kind: "filled",
    empty: "No fills yet. When the maker takes an order at your price, it shows up here.",
  },
  {
    key: "orders",
    label: "Orders",
    kind: "order",
    empty: "No order updates yet. Placing, changing, settling and stopping orders show up here.",
  },
  {
    key: "wallet",
    label: "Wallet",
    kind: "wallet",
    empty: "No withdrawals yet. What you withdraw to your wallet shows up here.",
  },
];

const PAGE = 50;

const ZONE = "America/New_York";
const DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: ZONE,
});
const DAY = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: ZONE,
});
const DAY_IN_YEAR = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: ZONE,
});

interface Item {
  readonly key: string;
  readonly event: MarketEvent;
  readonly line: EventLine;
  // Null when the event's block time doesn't parse, so it's shown without a time.
  readonly seconds: number | null;
}

interface Day {
  readonly key: string;
  // The Eastern calendar date as YYYY-MM-DD, or null for rows without a time.
  readonly date: string | null;
  readonly label: string;
  // Each row with its place in the list as shown.
  readonly rows: { readonly item: Item; readonly index: number }[];
}

function easternDate(seconds: number): string {
  const parts = DATE_PARTS.formatToParts(new Date(seconds * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// "Fri, Nov 20", with the year only when it isn't the current one.
function dayLabel(seconds: number, thisYear: string): string {
  const moment = new Date(seconds * 1000);
  return easternDate(seconds).startsWith(thisYear)
    ? DAY.format(moment)
    : DAY_IN_YEAR.format(moment);
}

// The events the holder would recognize, newest first. Events describeEvent has no words for are
// left out.
function itemsOf(events: readonly MarketEvent[], config: AppConfig): Item[] {
  const sideOf = sidesOf(events);
  return [...events]
    .sort((a, b) => b.block_number - a.block_number || b.log_index - a.log_index)
    .flatMap((event) => {
      const line = describeEvent(event, config, sideOf);
      if (line === null) return [];
      const ms = Date.parse(event.block_time);
      const seconds = Number.isNaN(ms) ? null : Math.floor(ms / 1000);
      return [{ key: `${event.block_number}:${event.log_index}`, event, line, seconds }];
    });
}

function inTab(items: readonly Item[], tab: Tab): readonly Item[] {
  return tab.kind === null ? items : items.filter((item) => item.line.kind === tab.kind);
}

// Rows are newest first, so the rows of one day sit next to each other.
function byDay(items: readonly Item[], thisYear: string): Day[] {
  const days: Day[] = [];
  items.forEach((item, index) => {
    const date = item.seconds === null ? null : easternDate(item.seconds);
    const last = days.at(-1);
    if (last?.date === date) {
      last.rows.push({ item, index });
      return;
    }
    days.push({
      key: item.key,
      date,
      label: item.seconds === null ? "Time unavailable" : dayLabel(item.seconds, thisYear),
      rows: [{ item, index }],
    });
  });
  return days;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function Row({
  config,
  item,
  ref,
}: {
  readonly config: AppConfig;
  readonly item: Item;
  // Set on the first row a "Show more" revealed, which takes focus.
  readonly ref: Ref<HTMLLIElement> | undefined;
}) {
  const { event, line, seconds } = item;
  const url = txUrl(config, event.tx_hash);
  const hash = shortHash(event.tx_hash);
  const classes = ["ac-row", `ac-row-${line.kind}`];
  if (line.amount === null) classes.push("ac-row-quiet");
  return (
    <li ref={ref} tabIndex={ref === undefined ? undefined : -1} className={classes.join(" ")}>
      <span className="ac-mark" aria-hidden="true" />
      <p className="ac-title">{line.title}</p>
      {line.amount !== null && <p className="ac-amount num">{line.amount}</p>}
      {line.detail !== null && <p className="ac-detail">{line.detail}</p>}
      <p className="ac-time num">
        {seconds !== null && <time dateTime={event.block_time}>{easternClock(seconds)}</time>}
      </p>
      {url === null ? (
        <p className="ac-tx num" title={event.tx_hash}>
          <span className="visually-hidden">Transaction </span>
          {hash}
        </p>
      ) : (
        <a className="ac-tx ac-tx-link num" href={url} target="_blank" rel="noreferrer">
          <span className="visually-hidden">Transaction </span>
          {hash}
          <span className="visually-hidden"> (opens in a new tab)</span>
          <NavIcon d={EXTERNAL_ICON} />
        </a>
      )}
    </li>
  );
}

// Keyed by tab, so switching tabs starts again at the first page.
function ActivityList({
  config,
  tab,
  items,
  thisYear,
}: {
  readonly config: AppConfig;
  readonly tab: Tab;
  readonly items: readonly Item[];
  readonly thisYear: string;
}) {
  const [limit, setLimit] = useState(PAGE);
  const revealed = useRef<HTMLLIElement>(null);

  if (items.length === 0) {
    return (
      <article className="card ac-card ac-empty">
        <p className="muted">{tab.empty}</p>
        {tab.kind === null && (
          <Link className="btn btn-ink btn-sm" to="/trade">
            Place an order
          </Link>
        )}
      </article>
    );
  }

  // After "Show more", focus moves to the first row it revealed, so the keyboard carries on from
  // there rather than from a button that may be gone.
  const revealedAt = limit > PAGE ? limit - PAGE : null;
  const showMore = (): void => {
    flushSync(() => {
      setLimit(limit + PAGE);
    });
    revealed.current?.focus();
  };

  return (
    <article className="card ac-card">
      {byDay(items.slice(0, limit), thisYear).map((day) => (
        <section key={day.key} className="ac-day">
          <h2 className="ac-day-title">
            {day.date === null ? day.label : <time dateTime={day.date}>{day.label}</time>}
          </h2>
          <ol>
            {day.rows.map(({ item, index }) => (
              <Row
                key={item.key}
                config={config}
                item={item}
                ref={index === revealedAt ? revealed : undefined}
              />
            ))}
          </ol>
        </section>
      ))}
      {items.length > limit && (
        <div className="ac-more">
          <p className="ac-count num">
            Showing {limit} of {items.length}
          </p>
          <button type="button" className="btn btn-outline btn-sm" onClick={showMore}>
            Show more
          </button>
        </div>
      )}
    </article>
  );
}

export function ActivityPage(): ReactNode {
  const { config, view, history } = useApp();
  const [params, setParams] = useSearchParams();

  if (view === null) return null;
  if (history.status === "idle") {
    return (
      <section className="card notice-card">
        <h2 className="h3">Your activity</h2>
        <p className="muted">Connect a wallet to see your activity.</p>
      </section>
    );
  }
  if (history.status !== "ready") {
    return (
      <section
        className="card notice-card ac-state"
        role={history.status === "loading" ? "status" : undefined}
      >
        <h2 className="h3">Your activity</h2>
        <HistoryNote />
      </section>
    );
  }

  const asked = params.get("show");
  const tab = TABS.find((t) => t.key === asked) ?? ALL;
  const items = itemsOf(history.events, config);

  return (
    <>
      <div className="page-head">
        <div className="tabs" role="group" aria-label="Show activity">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={t === tab ? "tab is-active" : "tab"}
              aria-pressed={t === tab}
              onClick={() => {
                setParams(t === ALL ? {} : { show: t.key }, { replace: true });
              }}
            >
              {t.label}
              <span className="tab-count num">{inTab(items, t).length}</span>
            </button>
          ))}
        </div>
        <p className="ac-note">Bids and premiums come from the maker the Vayle team operates.</p>
      </div>
      <ActivityList
        key={tab.key}
        config={config}
        tab={tab}
        items={inTab(items, tab)}
        thisYear={easternDate(view.now).slice(0, 4)}
      />
      <div className="ac-history">
        <HistoryNote />
      </div>
    </>
  );
}
