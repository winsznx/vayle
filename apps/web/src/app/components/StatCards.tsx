import { withdraw, type Call } from "@vayle/market";
import { TokenIcon } from "../../ui/TokenIcon.tsx";
import type { Run } from "../state.tsx";
import type { AppConfig } from "../config.ts";
import { dollars, easternClock, easternTime, feedDollars, tokens, usdgAmount } from "../format.ts";
import type { AccountView, MarketView } from "../useMarket.ts";
import { BID_WINDOW, bidOpensAt, type Epoch } from "../week.ts";

const STAGES = ["Close", "Bids", "Batch", "Week", "Next close"] as const;

// Where the week stands, by the same clock the contracts keep.
function stageOf(e: Epoch, now: number): number {
  const bidOpen = bidOpensAt(e);
  if (now < bidOpen) return 0;
  if (now < bidOpen + BID_WINDOW) return 1;
  if (now < e.batchDeadline) return 2;
  if (now < e.expiry) return 3;
  return 4;
}

function stageNote(e: Epoch, now: number): string {
  const bidOpen = bidOpensAt(e);
  switch (stageOf(e, now)) {
    case 0:
      return `Bids open at ${easternClock(bidOpen)}`;
    case 1:
      return `Taking bids until ${easternClock(bidOpen + BID_WINDOW)}`;
    case 2:
      return `Batch window until ${easternTime(e.batchDeadline)}`;
    case 3:
      return `Ends ${easternTime(e.expiry)}`;
    default:
      return "This week has ended";
  }
}

export function WeekCard({
  config,
  view,
}: {
  readonly config: AppConfig;
  readonly view: MarketView;
}) {
  const e = view.epoch;
  if (e === null) {
    return (
      <article className="card stat stat-week">
        <div className="stat-head">
          <TokenIcon symbol="NVDA" size="lg" />
          <div>
            <p className="stat-title">{config.assetSymbol}</p>
            <p className="stat-note">The first week opens at the next weekly close</p>
          </div>
        </div>
        <p className="figure num">{feedDollars(view.feedAnswer, view.feedDecimals)}</p>
        <p className="stat-caption">Latest feed price</p>
      </article>
    );
  }
  const stage = stageOf(e, view.now);
  return (
    <article className="card stat stat-week">
      <div className="stat-head">
        <TokenIcon symbol="NVDA" size="lg" />
        <div>
          <p className="stat-title">{config.assetSymbol}</p>
          <p className="stat-note">{stageNote(e, view.now)}</p>
        </div>
      </div>
      <p className="figure num">{dollars(e.referencePrice)}</p>
      <p className="stat-caption">Close on {easternTime(e.opening)}</p>
      <ol className="stage-track" aria-label="Where this week stands">
        {STAGES.map((label, i) => (
          <li
            key={label}
            className={i === stage ? "is-current" : i < stage ? "is-past" : undefined}
            aria-current={i === stage ? "step" : undefined}
          >
            <span className="stage-label">{label}</span>
          </li>
        ))}
      </ol>
    </article>
  );
}

export function WithdrawCard(props: {
  readonly config: AppConfig;
  readonly account: AccountView | null;
  // False while the wallet is on another chain: the amounts still show, the button waits.
  readonly canAct: boolean;
  readonly run: Run;
  readonly busy: boolean;
}) {
  const { config, account, canAct, run, busy } = props;
  const calls: Call[] = [];
  if (account !== null && account.claimableUsdg > 0n) {
    calls.push(withdraw(config.market, config.usdg, account.claimableUsdg));
  }
  if (account !== null && account.claimableAsset > 0n) {
    calls.push(withdraw(config.market, config.asset, account.claimableAsset));
  }
  return (
    <article className="card stat">
      <p className="stat-title">Ready to withdraw</p>
      {account === null ? (
        <p className="stat-empty">Connect a wallet to see what&apos;s yours.</p>
      ) : calls.length === 0 ? (
        <p className="stat-empty">Nothing to withdraw yet. Premiums and settlements land here.</p>
      ) : (
        <ul className="amounts">
          {account.claimableUsdg > 0n && (
            <li>
              <TokenIcon symbol="USDG" size="md" />
              <span className="amount num">
                {usdgAmount(account.claimableUsdg, config.usdgDecimals)}
              </span>
            </li>
          )}
          {account.claimableAsset > 0n && (
            <li>
              <TokenIcon symbol="NVDA" size="md" />
              <span className="amount num">
                {tokens(account.claimableAsset, config.assetSymbol, config.assetDecimals)}
              </span>
            </li>
          )}
        </ul>
      )}
      {calls.length > 0 && (
        <button
          type="button"
          className="btn btn-ink stat-action"
          disabled={busy || !canAct}
          onClick={() => void run("Withdraw", calls)}
        >
          Withdraw
        </button>
      )}
    </article>
  );
}

// What the holder has locked in orders that are still active: NVDA behind sell orders, USDG behind
// buy orders at each order's price.
export function LockedCard({
  config,
  account,
}: {
  readonly config: AppConfig;
  readonly account: AccountView | null;
}) {
  const rawUnit = 10n ** BigInt(config.assetDecimals);
  let lockedAsset = 0n;
  let lockedUsdg = 0n;
  let active = 0;
  for (const order of account?.orders ?? []) {
    if (order.status !== "active") continue;
    active += 1;
    if (order.side === 0) lockedAsset += order.size;
    else lockedUsdg += (order.size * order.target) / rawUnit;
  }
  return (
    <article className="card stat">
      <p className="stat-title">In your orders</p>
      {account === null ? (
        <p className="stat-empty">Your locked NVDA and USDG show here.</p>
      ) : active === 0 ? (
        <p className="stat-empty">No active orders. Pick a price on the ladder to place one.</p>
      ) : (
        <ul className="amounts">
          {lockedAsset > 0n && (
            <li>
              <TokenIcon symbol="NVDA" size="md" />
              <span className="amount num">
                {tokens(lockedAsset, config.assetSymbol, config.assetDecimals)}
              </span>
            </li>
          )}
          {lockedUsdg > 0n && (
            <li>
              <TokenIcon symbol="USDG" size="md" />
              <span className="amount num">{usdgAmount(lockedUsdg, config.usdgDecimals)}</span>
            </li>
          )}
        </ul>
      )}
      {account !== null && active > 0 && (
        <p className="stat-caption">
          {active === 1 ? "1 active order" : `${active} active orders`}
        </p>
      )}
    </article>
  );
}
