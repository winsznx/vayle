import type { OrderState } from "@vayle/market";
import { Link, useSearchParams } from "react-router";
import { HistoryNote } from "../components/HistoryNote.tsx";
import { lineOf, OrdersTable } from "../components/Orders.tsx";
import { useApp } from "../state.tsx";

type Show = "open" | "action" | "week" | "waiting" | "closed";

const TABS: readonly { readonly key: Show; readonly label: string }[] = [
  { key: "open", label: "Open" },
  { key: "action", label: "Needs you" },
  { key: "week", label: "This week" },
  { key: "waiting", label: "Waiting" },
  { key: "closed", label: "Closed" },
];

const EMPTY: Readonly<Record<Show, string>> = {
  open: "No open targets. Choose a price to set one.",
  action: "Nothing needs you right now.",
  week: "No target is in this week's trade.",
  waiting: "No target is waiting for a week.",
  closed: "No closed targets yet.",
};

function isShow(value: string | null): value is Show {
  return TABS.some((t) => t.key === value);
}

export function OrdersPage() {
  const { config, view } = useApp();
  const [params, setParams] = useSearchParams();
  const asked = params.get("show");
  const show: Show = isShow(asked) ? asked : "open";
  const account = view?.account ?? null;

  if (view === null) return null;
  if (account === null) {
    return (
      <section className="card notice-card">
        <h2 className="h3">Your targets</h2>
        <p className="muted">Connect a wallet to see your targets.</p>
      </section>
    );
  }

  const groups: Record<Show, OrderState[]> = {
    open: [],
    action: [],
    week: [],
    waiting: [],
    closed: [],
  };
  for (const order of account.orders) {
    const line = lineOf(config, view, account, order);
    const closed = order.status !== "active" && order.series === 0n;
    if (closed) {
      groups.closed.push(order);
      continue;
    }
    groups.open.push(order);
    if (line.action === "settle" || line.action === "finalize-then-settle")
      groups.action.push(order);
    if (order.series !== 0n) groups.week.push(order);
    else groups.waiting.push(order);
  }
  const shown = [...groups[show]].reverse();

  return (
    <>
      <div className="page-head">
        <div className="tabs" role="group" aria-label="Show targets">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={t.key === show ? "tab is-active" : "tab"}
              aria-pressed={t.key === show}
              onClick={() => {
                setParams(t.key === "open" ? {} : { show: t.key }, { replace: true });
              }}
            >
              {t.label}
              <span className="tab-count num">{groups[t.key].length}</span>
            </button>
          ))}
        </div>
        <Link className="btn btn-ink btn-sm" to="/trade">
          Set a target
        </Link>
      </div>
      <article className="card orders-card">
        {shown.length === 0 ? (
          <p className="empty-state">{EMPTY[show]}</p>
        ) : (
          <OrdersTable
            orders={shown}
            label={`${TABS.find((t) => t.key === show)?.label ?? ""} targets`}
          />
        )}
      </article>
      <HistoryNote />
    </>
  );
}
