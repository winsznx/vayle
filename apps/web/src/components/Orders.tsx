import { cancelOrder, finalize, settleOrder, type Call, type OrderState } from "@vayle/market";
import type { Run } from "../App.tsx";
import type { AppConfig } from "../config.ts";
import { usdgAmount } from "../format.ts";
import { describeOrder } from "../orders.ts";
import type { OrderHistory } from "../useHistory.ts";
import type { AccountView, MarketView } from "../useMarket.ts";

const MAX_TICKS = 8;

// Filled weeks as solid ticks, then the current run of skipped weeks as hollow ones.
function Ticks({ history }: { readonly history: OrderHistory }) {
  const filled = Math.min(history.weeksFilled, MAX_TICKS);
  const skipped = Math.min(history.skipStreak, MAX_TICKS - filled);
  if (filled + skipped === 0) return null;
  return (
    <span className="ticks" aria-hidden="true">
      {Array.from({ length: filled }, (_, i) => (
        <span key={`f${i}`} className="tick filled" />
      ))}
      {Array.from({ length: skipped }, (_, i) => (
        <span key={`s${i}`} className="tick skipped" />
      ))}
    </span>
  );
}

function historyText(history: OrderHistory, decimals: number): string {
  const parts = [`Earned ${usdgAmount(history.premiumEarned, decimals)}`];
  parts.push(history.weeksFilled === 1 ? "filled 1 week" : `filled ${history.weeksFilled} weeks`);
  if (history.skipStreak > 0) {
    parts.push(
      history.skipStreak === 1
        ? "skipped the last week"
        : `skipped the last ${history.skipStreak} weeks in a row`,
    );
  }
  return `${parts.join(", ")}.`;
}

export function Orders(props: {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly account: AccountView;
  readonly history: ReadonlyMap<bigint, OrderHistory>;
  readonly run: Run;
  readonly busy: boolean;
}) {
  const { config, view, account, history, run, busy } = props;
  const visible = account.orders.filter((o) => o.status !== "closed" || o.series !== 0n);
  if (visible.length === 0) {
    return <p className="quiet">No orders yet. Choose a price on the ladder to place one.</p>;
  }

  // Settling is a step the holder needs to take, so it's the strong button. Cancelling stays quiet.
  const actionFor = (
    order: OrderState,
  ): { label: string; calls: Call[]; quiet: boolean } | null => {
    const series = order.series === 0n ? null : (account.series.get(order.series) ?? null);
    const line = describeOrder(
      order,
      series,
      view.epoch,
      view.now,
      config.assetSymbol,
      account.heldOpen.get(order.series) ?? null,
    );
    if (line.action === "settle")
      return { label: "Settle", calls: [settleOrder(config.market, order.id)], quiet: false };
    if (line.action === "finalize-then-settle") {
      return {
        label: "Settle",
        calls: [finalize(config.market, order.series), settleOrder(config.market, order.id)],
        quiet: false,
      };
    }
    if (line.action === "cancel")
      return { label: "Cancel order", calls: [cancelOrder(config.market, order.id)], quiet: true };
    return null;
  };

  return (
    <ul className="order-list">
      {visible.map((order) => {
        const series = order.series === 0n ? null : (account.series.get(order.series) ?? null);
        const line = describeOrder(
          order,
          series,
          view.epoch,
          view.now,
          config.assetSymbol,
          account.heldOpen.get(order.series) ?? null,
        );
        const action = actionFor(order);
        const past = history.get(order.id);
        return (
          <li key={order.id.toString()} className="order">
            <p className="order-title">
              {line.title} <span className="limit-price-small">{line.price}</span>
            </p>
            <p className="order-status">{line.status}</p>
            {past !== undefined && (
              <p
                className="order-history"
                title={past.toBlock === null ? undefined : `As of block ${past.toBlock}`}
              >
                <Ticks history={past} />
                {historyText(past, config.usdgDecimals)}
              </p>
            )}
            {action !== null && (
              <button
                type="button"
                className={action.quiet ? "secondary" : undefined}
                disabled={busy}
                onClick={() => void run(action.label, action.calls)}
              >
                {action.label}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
