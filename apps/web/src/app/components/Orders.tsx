import { cancelOrder, finalize, settleOrder, type Call, type OrderState } from "@vayle/market";
import { TokenIcon } from "../../ui/TokenIcon.tsx";
import type { Run } from "../App.tsx";
import type { AppConfig } from "../config.ts";
import { usdgAmount } from "../format.ts";
import { describeOrder, type OrderLine } from "../orders.ts";
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
        <span key={`f${i}`} className="tick tick-filled" />
      ))}
      {Array.from({ length: skipped }, (_, i) => (
        <span key={`s${i}`} className="tick tick-skipped" />
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

interface Action {
  readonly label: string;
  readonly calls: Call[];
  // Settling is a step the holder needs to take, so it's the strong button. Cancelling stays quiet.
  readonly quiet: boolean;
}

function actionFor(config: AppConfig, order: OrderState, line: OrderLine): Action | null {
  if (line.action === "settle") {
    return { label: "Settle", calls: [settleOrder(config.market, order.id)], quiet: false };
  }
  if (line.action === "finalize-then-settle") {
    return {
      label: "Settle",
      calls: [finalize(config.market, order.series), settleOrder(config.market, order.id)],
      quiet: false,
    };
  }
  if (line.action === "cancel") {
    return { label: "Cancel order", calls: [cancelOrder(config.market, order.id)], quiet: true };
  }
  return null;
}

export function Orders(props: {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly account: AccountView | null;
  readonly history: ReadonlyMap<bigint, OrderHistory>;
  readonly run: Run;
  readonly busy: boolean;
}) {
  const { config, view, account, history, run, busy } = props;
  const visible = account?.orders.filter((o) => o.status !== "closed" || o.series !== 0n) ?? [];

  return (
    <article className="card orders-card">
      <div className="card-head">
        <h2 id="orders-title" className="h3">
          Your orders
        </h2>
        {visible.length > 0 && <span className="card-count num">{visible.length}</span>}
      </div>
      {account === null ? (
        <p className="empty-state">Connect a wallet to see your orders.</p>
      ) : visible.length === 0 ? (
        <p className="empty-state">No orders yet. Choose a price on the ladder to place one.</p>
      ) : (
        <table className="orders-table" aria-labelledby="orders-title">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Price</th>
              <th scope="col">Status</th>
              <th scope="col">This week</th>
              <th scope="col">
                <span className="visually-hidden">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((order) => {
              const series =
                order.series === 0n ? null : (account.series.get(order.series) ?? null);
              const line = describeOrder(
                order,
                series,
                view.epoch,
                view.now,
                config.assetSymbol,
                account.heldOpen.get(order.series) ?? null,
              );
              const action = actionFor(config, order, line);
              const past = history.get(order.id);
              return (
                <tr key={order.id.toString()}>
                  <td data-label="Order">
                    <span className="order-name">
                      <TokenIcon symbol="NVDA" size="md" />
                      <span>{line.title.replace(/ at$/, "")}</span>
                    </span>
                  </td>
                  <td data-label="Price" className="order-price num">
                    {line.price}
                  </td>
                  <td data-label="Status">
                    <span className={`chip chip-${line.chip.tone}`}>{line.chip.label}</span>
                  </td>
                  <td data-label="This week" className="order-status">
                    {line.status}
                    {past !== undefined && (
                      <span
                        className="order-history"
                        title={past.toBlock === null ? undefined : `As of block ${past.toBlock}`}
                      >
                        <Ticks history={past} />
                        {historyText(past, config.usdgDecimals)}
                      </span>
                    )}
                  </td>
                  <td className="order-action">
                    {action !== null && (
                      <button
                        type="button"
                        className={action.quiet ? "btn btn-outline btn-sm" : "btn btn-ink btn-sm"}
                        disabled={busy}
                        onClick={() => void run(action.label, action.calls)}
                      >
                        {action.label}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </article>
  );
}
