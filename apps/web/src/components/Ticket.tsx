import { approve, placeOrder, type Call } from "@vayle/market";
import { useId, useState } from "react";
import { maxUint256 } from "viem";
import type { Run } from "../App.tsx";
import type { AppConfig } from "../config.ts";
import { dollars, easternTime, tokens, usdgAmount } from "../format.ts";
import { checkTicket } from "../ticket.ts";
import type { MarketView } from "../useMarket.ts";
import { BID_WINDOW, type Epoch, type Rung } from "../week.ts";

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
      ? `Placed now, it joins this week's batch, which starts ${easternTime(batchOpens)}.`
      : "Placed now, it can fill if the maker quotes it this week, or it joins next week's batch.";

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
      className="ticket"
      onSubmit={(event) => {
        event.preventDefault();
        place();
      }}
    >
      <p className="ticket-headline">
        <span>{selling ? `Sell ${config.assetSymbol} at` : `Buy ${config.assetSymbol} at`}</span>
        <span className="limit-price">{dollars(rung.strike)}</span>
      </p>
      <p className="ticket-how">
        {selling
          ? `Each week this order earns the week's bid, skips the week, or sells your ${config.assetSymbol} at ${dollars(rung.strike)}. It renews until it sells or you cancel.`
          : `Each week this order earns the week's bid, skips the week, or buys ${config.assetSymbol} at ${dollars(rung.strike)} with your USDG. It renews until it buys or you cancel.`}
      </p>
      <div className="fields">
        <label htmlFor={`${id}-amount`}>Amount</label>
        <div className="field">
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="1.00"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />
          <span>{config.assetSymbol}</span>
        </div>
        <label htmlFor={`${id}-minimum`}>Minimum premium</label>
        <div className="field">
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
          <span>USDG per {config.assetSymbol}</span>
        </div>
        <p id={`${id}-minimum-help`} className="help">
          Skip any week that pays less than this.
        </p>
      </div>
      {opposite.length > 0 && (
        <div className="flip">
          <input
            id={`${id}-flip`}
            type="checkbox"
            checked={flip}
            onChange={(event) => {
              setFlip(event.target.checked);
            }}
          />
          <label htmlFor={`${id}-flip`}>
            {selling
              ? "When it sells, place a buy order at"
              : "When it buys, place a sell order at"}
          </label>
          <select
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
      {result !== null && result.ok && (
        <p className="locks">
          Locks{" "}
          {selling
            ? tokens(result.ticket.collateral, config.assetSymbol, config.assetDecimals)
            : usdgAmount(result.ticket.collateral, config.usdgDecimals)}{" "}
          until it fills or you cancel.
        </p>
      )}
      {result !== null && !result.ok && <p className="problem">{result.problem}</p>}
      <p className="help">{timing}</p>
      {tradable ? (
        <button type="submit" className="primary" disabled={busy || result === null || !result.ok}>
          {selling ? "Place sell order" : "Place buy order"}
        </button>
      ) : (
        <p className="quiet">{notTradableReason}</p>
      )}
    </form>
  );
}
