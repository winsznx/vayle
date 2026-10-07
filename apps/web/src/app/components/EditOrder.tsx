import type { OrderState } from "@vayle/market";
import { formatFixed } from "@vayle/units";
import { useId, useState } from "react";
import { planEdit, type Move } from "../edit.ts";
import { dollars, tokens, usdgAmount } from "../format.ts";
import { useApp } from "../state.tsx";
import { ladder } from "../week.ts";

// The form that changes an order, on its page. What it may change and what that takes come from
// planEdit; this says it in the holder's words and sends it.

export function EditOrder({ order }: { readonly order: OrderState }) {
  const { config, view, run, busy, onChain } = useApp();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(order.target);
  const [amount, setAmount] = useState(formatFixed(order.size, config.assetDecimals));
  const [minimum, setMinimum] = useState(formatFixed(order.minPremium, config.usdgDecimals));
  const epoch = view?.epoch ?? null;
  const account = view?.account ?? null;
  if (order.status !== "active" || order.frozen || epoch === null || account === null) return null;

  const selling = order.side === 0;
  const attached = order.series !== 0n;
  const prices = [
    ...new Set([
      ...ladder(epoch)
        .filter((r) => r.side === (selling ? "sell" : "buy"))
        .map((r) => r.strike),
      order.target,
    ]),
  ].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const plan = planEdit(order, { target, amount, minimum }, epoch, account, config, {
    usdg: config.usdgDecimals,
    asset: config.assetDecimals,
  });
  const moveText = (move: Move): string => {
    const what = selling
      ? tokens(move.amount, config.assetSymbol, config.assetDecimals)
      : usdgAmount(move.amount, config.usdgDecimals);
    return move.direction === "locks"
      ? `Locks ${what} more from your wallet.`
      : `Frees ${what}, ready to withdraw.`;
  };

  const save = (): void => {
    if (plan.kind !== "ready") return;
    void run("Change order", [...plan.calls]).then((done) => {
      if (done) setOpen(false);
    });
  };

  return (
    <section className="card od-edit" aria-labelledby={`${id}-title`}>
      <div className="card-head od-edit-head">
        <div>
          <h2 id={`${id}-title`} className="h3">
            Change this order
          </h2>
          <p className="card-sub">
            {attached
              ? "Part of it is in this week's trade, so only the least premium can change until the week settles."
              : "Its price, amount and least premium change in one transaction, and it keeps its history."}
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
                <span className="field-unit">{config.assetSymbol}</span>
              </div>
            </>
          )}
          <label className="field-label" htmlFor={`${id}-minimum`}>
            Least per week
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
            <span className="field-unit">USDG per {config.assetSymbol}</span>
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
