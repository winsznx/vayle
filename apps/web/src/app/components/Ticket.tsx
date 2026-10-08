import { approve, placeOrder, type Call } from "@vayle/market";
import { formatFixed } from "@vayle/units";
import { useId, useState } from "react";
import { maxUint256 } from "viem";
import { CASH_SYMBOL } from "../../tokens.ts";
import { TokenLogo } from "../../ui/TokenLogo.tsx";
import type { Run } from "../state.tsx";
import type { AppConfig } from "../config.ts";
import { amountOf, dollars, easternTime, premium, unitOf, usdgAmount } from "../format.ts";
import type { Rate } from "../rates.ts";
import { capProblem, checkTicket, roomUnderCaps, type TicketResult } from "../ticket.ts";
import type { AssetView, MarketView } from "../useMarket.ts";
import { batchOpensAt, hasBatch, type Epoch, type Rung } from "../week.ts";

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
        Pick a rung on this week&apos;s ladder to set a sell target above the close or a buy target
        below it.
      </p>
    </article>
  );
}

// The form that sets a target at one rung of one market. The side follows from the rung: above the
// close it's a sell target, below it a buy target.
export function Ticket(props: {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly asset: AssetView;
  readonly epoch: Epoch;
  readonly rung: Rung;
  // What the rung is paid this week, from the rate sheet.
  readonly rate: Rate | null;
  // The rungs the rate sheet shows, for the target that follows a fill.
  readonly rungs: readonly Rung[];
  readonly tradable: boolean;
  readonly notTradableReason: string;
  readonly run: Run;
  readonly busy: boolean;
  readonly onPlaced: () => void;
}) {
  const { config, view, asset, epoch, rung, rate, rungs, tradable, notTradableReason } = props;
  const { run, busy, onPlaced } = props;
  const { market } = asset;
  const unit = unitOf(market);
  const id = useId();
  const [amount, setAmount] = useState("");
  const [minimum, setMinimum] = useState("");
  const [flip, setFlip] = useState(false);
  const opposite = rungs.filter((r) => r.side !== rung.side);
  const [flipTarget, setFlipTarget] = useState<bigint | null>(opposite[0]?.strike ?? null);

  const selling = rung.side === "sell";
  const account = view.account;
  const holding = account?.tokens.get(market.token) ?? null;
  const caps = selling ? asset.caps.sell : asset.caps.buy;
  const room =
    holding === null
      ? 0n
      : roomUnderCaps(
          caps,
          selling ? asset.open.sell : asset.open.buy,
          selling ? holding.walletOpen.sell : holding.walletOpen.buy,
        );
  const checked =
    account === null || holding === null || amount === ""
      ? null
      : checkTicket(
          { side: rung.side, strike: rung.strike, amount, minPremium: minimum },
          epoch,
          { asset: holding.balance, usdg: account.usdg.balance },
          config.usdgDecimals,
          unit,
        );
  // The caps bind the same way the market will check them when the target is sent.
  const overCap =
    checked?.ok === true ? capProblem(checked.ticket.size, room, caps, rung.side, unit) : null;
  const result =
    overCap === null ? checked : ({ ok: false, problem: overCap } satisfies TicketResult);
  const batchOpens = batchOpensAt(epoch);
  const timing =
    view.now >= epoch.expiry
      ? "This week has closed, so it waits for next week."
      : !hasBatch(epoch)
        ? `Can fill by quote until the close on ${easternTime(epoch.expiry)}.`
        : view.now < batchOpens
          ? `Joins this week's batch, which starts ${easternTime(batchOpens)}.`
          : "Can fill this week if the maker quotes it, or joins next week's batch.";

  // The most whole lots the wallet can cover, its tokens for a sell target and its USDG at this
  // price for a buy target, that also fit under the caps.
  const covered =
    account === null || holding === null
      ? 0n
      : selling
        ? holding.balance
        : (account.usdg.balance * epoch.rawUnit) / rung.strike;
  const maxSize = ((covered < room ? covered : room) / epoch.lot) * epoch.lot;

  const place = (): void => {
    if (result === null || !result.ok || account === null || holding === null) return;
    const token = selling ? market.token : config.usdg;
    const allowance = selling ? holding.allowance : account.usdg.allowance;
    const calls: Call[] = [];
    if (allowance < result.ticket.collateral) calls.push(approve(token, config.market, maxUint256));
    calls.push(
      placeOrder(config.market, {
        asset: market.token,
        side: selling ? 0 : 1,
        target: rung.strike,
        minPremium: result.ticket.minPremium,
        size: result.ticket.size,
        flip: flip && flipTarget !== null,
        flipTarget: flip && flipTarget !== null ? flipTarget : 0n,
      }),
    );
    void run(selling ? "Set sell target" : "Set buy target", calls).then((ok) => {
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
        <TokenLogo symbol={market.symbol} size="sm" />
        {selling ? `Sell target for ${market.symbol} at` : `Buy target for ${market.symbol} at`}
      </p>
      <p className="ticket-price num">{dollars(rung.strike)}</p>
      <p className="ticket-how">
        {selling
          ? "Each week a buyer pays you for the right to buy your tokens at that price when the market closes Friday. If the stock closes above it, your tokens sell at exactly your price. If not, you keep them and the payment, and it renews for another week."
          : "Each week you're paid for agreeing to buy tokens at that price when the market closes Friday. If the stock closes below your buy target, you buy at that price, even if the close is lower. If not, you keep your USDG and the payment, and it renews for another week."}
      </p>

      <div className="ticket-fields">
        <label className="field-label" htmlFor={`${id}-amount`}>
          Amount
        </label>
        <div className="field">
          <TokenLogo symbol={market.symbol} size="sm" />
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
          <span className="field-unit">{market.symbol}</span>
          {maxSize > 0n && (
            <button
              type="button"
              className="field-max"
              onClick={() => {
                setAmount(formatFixed(maxSize, market.decimals));
              }}
            >
              Max
            </button>
          )}
        </div>

        <label className="field-label" htmlFor={`${id}-minimum`}>
          Least payment each week
        </label>
        <div className="field">
          <TokenLogo symbol={CASH_SYMBOL} size="sm" />
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
          <span className="field-unit">USDG per {market.symbol}</span>
        </div>
        <p id={`${id}-minimum-help`} className="field-help">
          A week that bids less than this is skipped, and your target carries over.
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
            <span>
              {selling
                ? "When it sells, set a buy target at"
                : "When it buys, set a sell target at"}
            </span>
          </label>
          <select
            className="flip-select num"
            aria-label="Price for the target that follows"
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
                ? amountOf(result.ticket.collateral, unit)
                : usdgAmount(result.ticket.collateral, config.usdgDecimals)}
            </dd>
          </div>
        )}
        <div>
          <dt>Bid</dt>
          <dd className="num">
            {rate === null
              ? "No bid yet"
              : `${premium(rate.premium)} per ${market.symbol}, ${rate.source === "batch" ? "this week's batch bid" : "the maker's current bid"}`}
          </dd>
        </div>
        <div>
          <dt>Timing</dt>
          <dd>{timing}</dd>
        </div>
        <div>
          <dt>Buyer</dt>
          <dd>Currently one market maker operated by Vayle</dd>
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
          {selling ? "Set sell target" : "Set buy target"}
        </button>
      ) : (
        <p className="ticket-blocked">{notTradableReason}</p>
      )}
    </form>
  );
}
