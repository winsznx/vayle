import { withdraw, type Call } from "@vayle/market";
import type { Address } from "viem";
import type { AppConfig } from "../config.ts";
import { amountOf, dollars, feedDollars, unitOf, usdgAmount } from "../format.ts";
import type { Run } from "../state.tsx";
import type { AccountView, AssetView } from "../useMarket.ts";
import type { MarketHistory } from "../useMarketHistory.ts";
import "./dashboard.css";

// The holder's Stock Tokens and USDG on Robinhood Chain: in the wallet, locked in targets, and
// credited by the market and ready to withdraw. Each token is valued at its own feed's latest
// price, which prices one raw token, so raw amounts value directly.

// Amounts of each listed token, by its address, beside an amount of USDG.
interface Bag {
  readonly tokens: ReadonlyMap<Address, bigint>;
  readonly usdg: bigint;
}

// Every target's size is what it still has locked: a cancelled target keeps the part written into
// this week until that series settles. Targets on a market the build doesn't list aren't counted.
function lockedIn(account: AccountView, assets: readonly AssetView[]): Bag {
  const tokens = new Map<Address, bigint>();
  let usdg = 0n;
  for (const order of account.orders) {
    const asset = assets.find((a) => a.market.token === order.asset);
    if (asset === undefined) continue;
    if (order.side === 0) {
      tokens.set(asset.market.token, (tokens.get(asset.market.token) ?? 0n) + order.size);
    } else {
      usdg += (order.size * order.target) / asset.market.rawUnit;
    }
  }
  return { tokens, usdg };
}

interface Props {
  readonly config: AppConfig;
  readonly account: AccountView;
  readonly assets: readonly AssetView[];
  readonly history: MarketHistory;
  // False while the wallet is on another chain: the amounts still show, the button waits.
  readonly canAct: boolean;
  readonly run: Run;
  readonly busy: boolean;
}

export function Holdings(props: Props) {
  const { config, account, assets, history, canAct, run, busy } = props;
  const usdgScale = 10n ** BigInt(config.usdgDecimals);
  // A token's raw amount in USDG base units at its feed's latest answer.
  const valueOf = (asset: AssetView, raw: bigint): bigint =>
    (raw * asset.feedAnswer * usdgScale) /
    (10n ** BigInt(asset.feedDecimals) * asset.market.rawUnit);
  const value = (bag: Bag): bigint =>
    assets.reduce((sum, a) => sum + valueOf(a, bag.tokens.get(a.market.token) ?? 0n), bag.usdg);
  const amountsOf = (bag: Bag, none: string): string => {
    const parts = [
      ...assets.flatMap((a) => {
        const raw = bag.tokens.get(a.market.token) ?? 0n;
        return raw > 0n ? [amountOf(raw, unitOf(a.market))] : [];
      }),
      ...(bag.usdg > 0n ? [usdgAmount(bag.usdg, config.usdgDecimals)] : []),
    ];
    return parts.length === 0 ? none : parts.join(", ");
  };
  const held = (pick: (t: { balance: bigint; claimable: bigint }) => bigint): Bag => ({
    tokens: new Map(
      assets.map((a) => {
        const t = account.tokens.get(a.market.token);
        return [a.market.token, t === undefined ? 0n : pick(t)] as const;
      }),
    ),
    usdg: pick(account.usdg),
  });

  const wallet = held((t) => t.balance);
  const locked = lockedIn(account, assets);
  const claimable = held((t) => t.claimable);
  const rows = [
    { key: "wallet", label: "In your wallet", bag: wallet, none: "No Stock Tokens or USDG" },
    { key: "locked", label: "In your targets", bag: locked, none: "Nothing locked" },
    { key: "claimable", label: "Ready to withdraw", bag: claimable, none: "Nothing yet" },
  ] as const;
  const total = rows.reduce((sum, r) => sum + value(r.bag), 0n);

  const calls: Call[] = [];
  if (claimable.usdg > 0n) calls.push(withdraw(config.market, config.usdg, claimable.usdg));
  for (const [token, raw] of claimable.tokens) {
    if (raw > 0n) calls.push(withdraw(config.market, token, raw));
  }

  const summaries = history.status === "ready" ? [...history.summaries.values()] : [];
  const earned = summaries.reduce((sum, s) => sum + BigInt(s.premiumEarned), 0n);
  // Targets that have earned, not weeks: two targets paid in one week are one week, two targets.
  const earning = summaries.filter((s) => BigInt(s.premiumEarned) > 0n).length;
  const only = assets.length === 1 ? assets[0] : undefined;

  return (
    <section className="card holdings" aria-label="Your holdings">
      <p className="holdings-title">Your holdings</p>
      <p className="holdings-total num">{dollars(total, config.usdgDecimals)}</p>
      <p className="holdings-basis">
        {only === undefined
          ? "Stock Tokens valued at each one's latest feed price"
          : `${only.market.symbol} valued at ${feedDollars(only.feedAnswer, only.feedDecimals)}, the feed's latest price`}
      </p>
      <div className="holdings-bar" aria-hidden="true">
        {total > 0n &&
          rows.map((r) => {
            const share = Number((value(r.bag) * 10_000n) / total) / 100;
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
            <span className="holdings-value num">{dollars(value(r.bag), config.usdgDecimals)}</span>
            <span className="holdings-amounts">{amountsOf(r.bag, r.none)}</span>
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
          "What your targets earn adds up here."
        ) : earned === 0n ? (
          "Nothing earned yet. Payments add up here."
        ) : (
          <>
            Earned{" "}
            <span className="holdings-earned-amount num">
              {usdgAmount(earned, config.usdgDecimals)}
            </span>{" "}
            on {earning === 1 ? "1 target" : `${earning} targets`} so far
          </>
        )}
      </p>
    </section>
  );
}
