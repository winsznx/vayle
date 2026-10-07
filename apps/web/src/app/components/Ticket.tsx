import { approve, placeOrder, type Call } from "@vayle/market";
import { formatFixed } from "@vayle/units";
import { useId, useState } from "react";
import { maxUint256 } from "viem";
import { TokenIcon } from "../../ui/TokenIcon.tsx";
import type { Run } from "../state.tsx";
import type { AppConfig } from "../config.ts";
import { dollars, easternTime, tokens, usdgAmount } from "../format.ts";
import { checkTicket } from "../ticket.ts";
import type { MarketView } from "../useMarket.ts";
import { BID_WINDOW, type Epoch, type Rung } from "../week.ts";

export function TicketEmpty() {
  return (
    <article className="card ticket-card ticket-empty">
      <div className="ticket-empty-art" aria-hidden="true">
        <span />
        <span className="is-held" />
        <span />
      </div>
      <h2 className="h3">Choose a price</h2>
      <p className="muted">
        Pick a rung on this week&apos;s ladder. Your order earns each week&apos;s premium, skips the
        week, or fills at exactly that price.
      </p>
    </article>
  );
}

// The order form for one rung. The side follows from the rung: above the close the holder sells,
// below it they buy.
export function Ticket(props: {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly epoch: Epoch;
  readonly rung: Rung;
  readonly rungs: readonly Rung[];
  readonly tradable: boolean;
  readonly notTradableReason: string;
  readonly run: Run;
  readonly busy: boolean;
  readonly onPlaced: () => void;
}) {
  const { config, view, epoch, rung, rungs, tradable, notTradableReason, run, busy, onPlaced } =
    props;
  const id = useId();
  const [amount, setAmount] = useState("");
  const [minimum, setMinimum] = useState("");
  const [flip, setFlip] = useState(false);
  const opposite = rungs.filter((r) => r.side !== rung.side);
  const [flipTarget, setFlipTarget] = useState<bigint | null>(opposite[0]?.strike ?? null);

  const selling = rung.side === "sell";
  const account = view.account;
  const result =
    account === null || amount === ""
      ? null
      : checkTicket(
          { side: rung.side, strike: rung.strike, amount, minPremium: minimum },
          epoch,
          { asset: account.balanceAsset, usdg: account.balanceUsdg },
          config.usdgDecimals,
          config.assetDecimals,
        );
  const batchOpens = epoch.opening + epoch.windowLength + BID_WINDOW;
  const timing =
    view.now < batchOpens
      ? `Joins this week's batch, which starts ${easternTime(batchOpens)}.`
      : "Can fill this week if the maker quotes it, or joins next week's batch.";

  // The most whole lots the wallet can cover: its NVDA for a sell, its USDG at this price for a buy.
  const maxSize =
    account === null
      ? 0n
      : selling
        ? (account.balanceAsset / epoch.lot) * epoch.lot
        : ((account.balanceUsdg * epoch.rawUnit) / rung.strike / epoch.lot) * epoch.lot;

  const place = (): void => {
    if (result === null || !result.ok || account === null) return;
    const token = selling ? config.asset : config.usdg;
    const allowance = selling ? account.allowanceAsset : account.allowanceUsdg;
    const calls: Call[] = [];
    if (allowance < result.ticket.collateral) calls.push(approve(token, config.market, maxUint256));
    calls.push(
      placeOrder(config.market, {
        asset: config.asset,
        side: selling ? 0 : 1,
        target: rung.strike,
        minPremium: result.ticket.minPremium,
        size: result.ticket.size,
        flip: flip && flipTarget !== null,
        flipTarget: flip && flipTarget !== null ? flipTarget : 0n,
      }),
    );
    void run(selling ? "Place sell order" : "Place buy order", calls).then((ok) => {
      if (ok) onPlaced();
    });
  };

  return (
    <form
      className="card ticket-card"
      onSubmit={(event) => {
        event.preventDefault();
        place();
      }}
    >
      <p className="ticket-kicker">
        {selling ? `Sell ${config.assetSymbol} at` : `Buy ${config.assetSymbol} at`}
      </p>
      <p className="ticket-price num">{dollars(rung.strike)}</p>
      <p className="ticket-how">
        {selling
          ? `Each week it earns the week's premium, skips the week, or sells your ${config.assetSymbol} at ${dollars(rung.strike)}. It renews until it sells or you cancel.`
          : `Each week it earns the week's premium, skips the week, or buys ${config.assetSymbol} at ${dollars(rung.strike)} with your USDG. It renews until it buys or you cancel.`}
      </p>

      <div className="ticket-fields">
        <label className="field-label" htmlFor={`${id}-amount`}>
          Amount
        </label>
        <div className="field">
          <TokenIcon symbol="NVDA" size="sm" />
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          <span className="field-unit">{config.assetSymbol}</span>
          {maxSize > 0n && (
            <button
              type="button"
              className="field-max"
              onClick={() => {
                setAmount(formatFixed(maxSize, config.assetDecimals));
              }}
            >
              Max
            </button>
          )}
        </div>

        <label className="field-label" htmlFor={`${id}-minimum`}>
          Least you&apos;ll take each week
        </label>
        <div className="field">
          <TokenIcon symbol="USDG" size="sm" />
          <input
            id={`${id}-minimum`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={minimum}
            aria-describedby={`${id}-minimum-help`}
            onChange={(event) => {
              setMinimum(event.target.value);
            }}
          />
          <span className="field-unit">USDG per {config.assetSymbol}</span>
        </div>
        <p id={`${id}-minimum-help`} className="field-help">
          A week that bids less is skipped, and the order waits for the next.
        </p>
      </div>

      {opposite.length > 0 && (
        <div className="flip-row">
          <label className="switch">
            <input
              type="checkbox"
              checked={flip}
              onChange={(event) => {
                setFlip(event.target.checked);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span>{selling ? "When it sells, buy back at" : "When it buys, sell again at"}</span>
          </label>
          <select
            className="flip-select num"
            aria-label="Price for the order that follows"
            disabled={!flip}
            value={flipTarget?.toString() ?? ""}
            onChange={(event) => {
              setFlipTarget(BigInt(event.target.value));
            }}
          >
            {opposite.map((r) => (
              <option key={r.strike.toString()} value={r.strike.toString()}>
                {dollars(r.strike)}
              </option>
            ))}
          </select>
        </div>
      )}

      <dl className="ticket-summary">
        {result !== null && result.ok && (
          <div>
            <dt>Locks</dt>
            <dd className="num">
              {selling
                ? tokens(result.ticket.collateral, config.assetSymbol, config.assetDecimals)
                : usdgAmount(result.ticket.collateral, config.usdgDecimals)}
            </dd>
          </div>
        )}
        <div>
          <dt>Timing</dt>
          <dd>{timing}</dd>
        </div>
        <div>
          <dt>Buyer</dt>
          <dd>The maker the Vayle team operates</dd>
        </div>
      </dl>
      {result !== null && !result.ok && (
        <p className="ticket-problem" role="alert">
          {result.problem}
        </p>
      )}

      {tradable ? (
        <button
          type="submit"
          className="btn btn-brand btn-lg ticket-submit"
          disabled={busy || result === null || !result.ok}
        >
          {selling ? "Place sell order" : "Place buy order"}
        </button>
      ) : (
        <p className="ticket-blocked">{notTradableReason}</p>
      )}
    </form>
  );
}
