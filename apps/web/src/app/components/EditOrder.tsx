import type { OrderState } from "@vayle/market";
import { formatFixed } from "@vayle/units";
import { useId, useState } from "react";
import { marketOfToken } from "../assets.ts";
import { planEdit, type Move } from "../edit.ts";
import { sheetRows } from "../rates.ts";
import { amountOf, dollars, unitOf, usdgAmount } from "../format.ts";
import { useApp } from "../state.tsx";
import { assetOf, type AccountView, type AssetView, type TokenAccount } from "../useMarket.ts";
import { ladder, type Epoch } from "../week.ts";

// The form that changes a target, on its page. What it may change and what that takes come from
// planEdit; this says it in the holder's words and sends it. Only a target on a market the build
// lists, in a week that's open, can be changed here.
export function EditOrder({ order }: { readonly order: OrderState }) {
  const { config, view } = useApp();
  if (view === null || order.status !== "active" || order.frozen) return null;
  const market = marketOfToken(config.markets, order.asset);
  const asset = market === undefined ? undefined : assetOf(view, market.token);
  const holding = market === undefined ? undefined : view.account?.tokens.get(market.token);
  const epoch = asset?.epoch ?? null;
  if (asset === undefined || epoch === null || view.account === null || holding === undefined) {
    return null;
  }
  return (
    <EditForm order={order} asset={asset} epoch={epoch} account={view.account} holding={holding} />
  );
}

function EditForm({
  order,
  asset,
  epoch,
  account,
  holding,
}: {
  readonly order: OrderState;
  readonly asset: AssetView;
  readonly epoch: Epoch;
  readonly account: AccountView;
  readonly holding: TokenAccount;
}) {
  const { config, run, busy, onChain, rates } = useApp();
  const { market } = asset;
  const unit = unitOf(market);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(order.target);
  const [amount, setAmount] = useState(formatFixed(order.size, market.decimals));
  const [minimum, setMinimum] = useState(formatFixed(order.minPremium, config.usdgDecimals));

  const selling = order.side === 0;
  const attached = order.series !== 0n;
  // The prices the rate sheet shows on this side, so a buy target moves only to a price with a bid,
  // and the price the target holds now.
  const inputs = rates(asset);
  const shown = inputs === null ? [] : sheetRows(ladder(epoch), inputs).map((r) => r.rung);
  const prices = [
    ...new Set([
      ...shown.filter((r) => r.side === (selling ? "sell" : "buy")).map((r) => r.strike),
      order.target,
    ]),
  ].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const plan = planEdit(
    order,
    { target, amount, minimum },
    epoch,
    {
      balanceAsset: holding.balance,
      balanceUsdg: account.usdg.balance,
      allowanceAsset: holding.allowance,
      allowanceUsdg: account.usdg.allowance,
      walletOpen: holding.walletOpen,
    },
    { market: config.market, asset: market.token, usdg: config.usdg },
    { caps: asset.caps, open: asset.open },
    { usdg: config.usdgDecimals, asset: unit },
  );
  const moveText = (move: Move): string => {
    const what = selling
      ? amountOf(move.amount, unit)
      : usdgAmount(move.amount, config.usdgDecimals);
    return move.direction === "locks"
      ? `Locks ${what} more from your wallet.`
      : `Frees ${what}, ready to withdraw.`;
  };

  const save = (): void => {
    if (plan.kind !== "ready") return;
    void run("Change target", [...plan.calls]).then((done) => {
      if (done) setOpen(false);
    });
  };

  return (
    <section className="card od-edit" aria-labelledby={`${id}-title`}>
      <div className="card-head od-edit-head">
        <div>
          <h2 id={`${id}-title`} className="h3">
            Change this target
          </h2>
          <p className="card-sub">
            {attached
              ? "Part of it is in this week's trade, so only the least payment can change until the week settles."
              : "Its price, amount and least payment change in one transaction, and it keeps its history."}
          </p>
        </div>
        {!open && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            Change
          </button>
        )}
      </div>
      {open && (
        <form
          className="od-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          {!attached && (
            <>
              <label className="field-label" htmlFor={`${id}-price`}>
                Price
              </label>
              <select
                id={`${id}-price`}
                className="flip-select num"
                value={target.toString()}
                onChange={(event) => {
                  setTarget(BigInt(event.target.value));
                }}
              >
                {prices.map((p) => (
                  <option key={p.toString()} value={p.toString()}>
                    {dollars(p, config.usdgDecimals)}
                    {p === order.target ? " (now)" : ""}
                  </option>
                ))}
              </select>
              <label className="field-label" htmlFor={`${id}-amount`}>
                Amount
              </label>
              <div className="field">
                <input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
                <span className="field-unit">{market.symbol}</span>
              </div>
            </>
          )}
          <label className="field-label" htmlFor={`${id}-minimum`}>
            Least payment each week
          </label>
          <div className="field">
            <input
              id={`${id}-minimum`}
              inputMode="decimal"
              autoComplete="off"
              value={minimum}
              onChange={(event) => {
                setMinimum(event.target.value);
              }}
            />
            <span className="field-unit">USDG per {market.symbol}</span>
          </div>
          {plan.kind === "problem" ? (
            <p className="ticket-problem" role="alert">
              {plan.problem}
            </p>
          ) : (
            plan.kind === "ready" &&
            plan.move !== null && <p className="field-help">{moveText(plan.move)}</p>
          )}
          <div className="od-edit-actions">
            <button
              type="submit"
              className="btn btn-ink"
              disabled={plan.kind !== "ready" || busy || !onChain}
            >
              Save changes
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                setOpen(false);
              }}
            >
              Keep as is
            </button>
          </div>
          {!onChain && <p className="field-help">Switch your wallet to Robinhood Chain first.</p>}
        </form>
      )}
    </section>
  );
}
