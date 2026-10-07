import { withdraw, type Call } from "@vayle/market";
import type { AppConfig } from "../config.ts";
import { dollars, feedDollars, tokens, usdgAmount } from "../format.ts";
import type { Run } from "../state.tsx";
import type { AccountView } from "../useMarket.ts";
import type { MarketHistory } from "../useMarketHistory.ts";
import "./dashboard.css";

// The holder's NVDA and USDG on Robinhood Chain: in the wallet, locked in orders, and credited by
// the market and ready to withdraw, valued at the feed's latest NVDA price. The feed and the
// market's strikes both price one raw token, so the amounts value directly.

interface Pair {
  readonly asset: bigint;
  readonly usdg: bigint;
}

// Every order's size is what it still has locked: a cancelled order keeps the part written into
// this week until that series settles.
function lockedIn(account: AccountView, rawUnit: bigint): Pair {
  let asset = 0n;
  let usdg = 0n;
  for (const order of account.orders) {
    if (order.side === 0) asset += order.size;
    else usdg += (order.size * order.target) / rawUnit;
  }
  return { asset, usdg };
}

function amountsOf(pair: Pair, config: AppConfig, none: string): string {
  const parts = [
    ...(pair.asset > 0n ? [tokens(pair.asset, config.assetSymbol, config.assetDecimals)] : []),
    ...(pair.usdg > 0n ? [usdgAmount(pair.usdg, config.usdgDecimals)] : []),
  ];
  return parts.length === 0 ? none : parts.join(" and ");
}

interface Props {
  readonly config: AppConfig;
  readonly account: AccountView;
  readonly feedAnswer: bigint;
  readonly feedDecimals: number;
  readonly history: MarketHistory;
  // False while the wallet is on another chain: the amounts still show, the button waits.
  readonly canAct: boolean;
  readonly run: Run;
  readonly busy: boolean;
}

export function Holdings(props: Props) {
  const { config, account, feedAnswer, feedDecimals, history, canAct, run, busy } = props;
  const rawUnit = 10n ** BigInt(config.assetDecimals);
  const priceUsdg = (feedAnswer * 10n ** BigInt(config.usdgDecimals)) / 10n ** BigInt(feedDecimals);
  const value = (pair: Pair): bigint => pair.usdg + (pair.asset * priceUsdg) / rawUnit;

  const wallet = { asset: account.balanceAsset, usdg: account.balanceUsdg };
  const locked = lockedIn(account, rawUnit);
  const claimable = { asset: account.claimableAsset, usdg: account.claimableUsdg };
  const rows = [
    { key: "wallet", label: "In your wallet", pair: wallet, none: "No NVDA or USDG" },
    { key: "locked", label: "In your orders", pair: locked, none: "Nothing locked" },
    { key: "claimable", label: "Ready to withdraw", pair: claimable, none: "Nothing yet" },
  ] as const;
  const total = rows.reduce((sum, r) => sum + value(r.pair), 0n);

  const calls: Call[] = [];
  if (claimable.usdg > 0n) calls.push(withdraw(config.market, config.usdg, claimable.usdg));
  if (claimable.asset > 0n) calls.push(withdraw(config.market, config.asset, claimable.asset));

  const summaries = history.status === "ready" ? [...history.summaries.values()] : [];
  const earned = summaries.reduce((sum, s) => sum + BigInt(s.premiumEarned), 0n);
  // Orders that have earned, not weeks: two orders paid in one week are one week, two orders.
  const earning = summaries.filter((s) => BigInt(s.premiumEarned) > 0n).length;

  return (
    <section className="card holdings" aria-label="Your holdings">
      <p className="holdings-title">Your holdings</p>
      <p className="holdings-total num">{dollars(total, config.usdgDecimals)}</p>
      <p className="holdings-basis">
        NVDA valued at {feedDollars(feedAnswer, feedDecimals)}, the feed&apos;s latest price
      </p>
      <div className="holdings-bar" aria-hidden="true">
        {total > 0n &&
          rows.map((r) => {
            const share = Number((value(r.pair) * 10_000n) / total) / 100;
            return share > 0 ? (
              <span
                key={r.key}
                className={`holdings-bar-${r.key}`}
                style={{ width: `${share}%` }}
              />
            ) : null;
          })}
      </div>
      <ul className="holdings-rows">
        {rows.map((r) => (
          <li key={r.key} className="holdings-row">
            <span className={`holdings-swatch holdings-swatch-${r.key}`} aria-hidden="true" />
            <span className="holdings-label">{r.label}</span>
            <span className="holdings-value num">
              {dollars(value(r.pair), config.usdgDecimals)}
            </span>
            <span className="holdings-amounts">{amountsOf(r.pair, config, r.none)}</span>
          </li>
        ))}
      </ul>
      {calls.length > 0 && (
        <button
          type="button"
          className="btn btn-ink holdings-action"
          disabled={busy || !canAct}
          onClick={() => void run("Withdraw", calls)}
        >
          Withdraw
        </button>
      )}
      <p className="holdings-earned">
        {history.status !== "ready" ? (
          "What your orders earn adds up here."
        ) : earned === 0n ? (
          "Nothing earned yet. Premiums from the team-operated maker add up here."
        ) : (
          <>
            Earned{" "}
            <span className="holdings-earned-amount num">
              {usdgAmount(earned, config.usdgDecimals)}
            </span>{" "}
            on {earning === 1 ? "1 order" : `${earning} orders`} so far
          </>
        )}
      </p>
    </section>
  );
}
