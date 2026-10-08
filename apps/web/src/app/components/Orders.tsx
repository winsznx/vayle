import {
  cancelOrder,
  finalize,
  settleOrder,
  type Call,
  type OrderState,
  type OrderSummary,
} from "@vayle/market";
import { Link } from "react-router";
import { TickerBadge, type BadgeSize } from "../../ui/TickerBadge.tsx";
import { marketOfToken } from "../assets.ts";
import type { AppConfig } from "../config.ts";
import { unitOf, usdgAmount } from "../format.ts";
import { describeOrder, nameOf, type OrderLine } from "../orders.ts";
import { useApp } from "../state.tsx";
import { assetOf, type AccountView, type MarketView } from "../useMarket.ts";

const MAX_TICKS = 8;

// Filled weeks as solid ticks, then the current run of skipped weeks as hollow ones.
export function Ticks({ summary }: { readonly summary: OrderSummary }) {
  const filled = Math.min(summary.weeksFilled, MAX_TICKS);
  const skipped = Math.min(summary.skipStreak, MAX_TICKS - filled);
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

// weeksFilled counts the weeks the order was written into and paid for, not fills at its price.
export function summaryText(summary: OrderSummary, decimals: number): string {
  if (summary.weeksFilled === 0 && summary.skipStreak === 0) return "Nothing earned yet.";
  const earned = usdgAmount(BigInt(summary.premiumEarned), decimals);
  const parts = [
    summary.weeksFilled === 1
      ? `Earned ${earned} over 1 paid week`
      : `Earned ${earned} over ${summary.weeksFilled} paid weeks`,
  ];
  if (summary.skipStreak > 0) {
    parts.push(
      summary.skipStreak === 1
        ? "skipped the last week"
        : `skipped the last ${summary.skipStreak} weeks in a row`,
    );
  }
  return `${parts.join(", ")}.`;
}

export interface Action {
  readonly label: string;
  readonly calls: Call[];
  // Settling is a step the holder needs to take, so it's the strong button. The others stay quiet.
  readonly quiet: boolean;
}

export function actionFor(config: AppConfig, order: OrderState, line: OrderLine): Action | null {
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
    return { label: "Cancel target", calls: [cancelOrder(config.market, order.id)], quiet: true };
  }
  if (line.action === "stop-renewing") {
    return { label: "Stop renewing", calls: [cancelOrder(config.market, order.id)], quiet: true };
  }
  return null;
}

// How a target reads right now, on its own market's week, with the series it's in and the end
// finalize reports when the chain's been quiet.
export function lineOf(
  config: AppConfig,
  view: MarketView,
  account: AccountView,
  order: OrderState,
): OrderLine {
  const market = marketOfToken(config.markets, order.asset);
  const asset = market === undefined ? undefined : assetOf(view, market.token);
  const series = order.series === 0n ? null : (account.series.get(order.series) ?? null);
  return describeOrder(
    order,
    series,
    asset?.epoch ?? null,
    view.now,
    market === undefined ? null : unitOf(market),
    account.heldOpen.get(order.series) ?? null,
  );
}

// The ticker badge of a target's market. A market the build doesn't list shows its token's
// address, shortened, in an outlined badge.
export function OrderBadge({
  config,
  order,
  size,
}: {
  readonly config: AppConfig;
  readonly order: OrderState;
  readonly size: BadgeSize;
}) {
  const market = marketOfToken(config.markets, order.asset);
  return market === undefined ? (
    <TickerBadge symbol={`${order.asset.slice(0, 6)}…${order.asset.slice(-4)}`} size={size} quiet />
  ) : (
    <TickerBadge symbol={market.symbol} size={size} />
  );
}

export function OrdersTable({
  orders,
  label,
}: {
  readonly orders: readonly OrderState[];
  readonly label: string;
}) {
  const { config, view, history, run, busy, onChain } = useApp();
  const account = view?.account ?? null;
  if (view === null || account === null) return null;
  const summaries = history.status === "ready" ? history.summaries : null;
  return (
    <table className="orders-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Target</th>
          <th scope="col">Price</th>
          <th scope="col">Status</th>
          <th scope="col">This week</th>
          <th scope="col">
            <span className="visually-hidden">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => {
          const line = lineOf(config, view, account, order);
          const action = actionFor(config, order, line);
          const summary = summaries?.get(order.id.toString());
          return (
            <tr key={order.id.toString()}>
              <td data-label="Target">
                <Link className="order-name" to={`/orders/${order.id.toString()}`}>
                  <OrderBadge config={config} order={order} size="md" />
                  <span>{nameOf(line)}</span>
                </Link>
              </td>
              <td data-label="Price" className="order-price num">
                {line.price}
              </td>
              <td data-label="Status">
                <span className={`chip chip-${line.chip.tone}`}>{line.chip.label}</span>
              </td>
              <td data-label="This week" className="order-status">
                {line.status}
                {summary !== undefined && (
                  <span className="order-history">
                    <Ticks summary={summary} />
                    {summaryText(summary, config.usdgDecimals)}
                  </span>
                )}
              </td>
              <td className="order-action">
                {action !== null && (
                  <button
                    type="button"
                    className={action.quiet ? "btn btn-outline btn-sm" : "btn btn-ink btn-sm"}
                    disabled={busy || !onChain}
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
  );
}
