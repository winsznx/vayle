import { Fragment, useState } from "react";
import type { Run } from "../App.tsx";
import type { AppConfig } from "../config.ts";
import { dollars, premium } from "../format.ts";
import type { MarketView } from "../useMarket.ts";
import { ladder, type Rung } from "../week.ts";
import { Ticket } from "./Ticket.tsx";

// This week's strikes, highest first, with the close between the sell rungs above it and the buy
// rungs below. Choosing a rung opens the order ticket right under it.
export function Ladder(props: {
  readonly config: AppConfig;
  readonly view: MarketView;
  readonly tradable: boolean;
  readonly notTradableReason: string;
  readonly run: Run;
  readonly busy: boolean;
}) {
  const { config, view, tradable, notTradableReason, run, busy } = props;
  const [chosen, setChosen] = useState<bigint | null>(null);
  const e = view.epoch;
  if (e === null) return null;
  const rungs = ladder(e);
  const firstBuy = rungs.findIndex((r) => r.side === "buy");
  const closeAt = firstBuy === -1 ? rungs.length : firstBuy;

  const rungRow = (rung: Rung) => {
    const selected = chosen === rung.strike;
    const bid = view.bids.get(rung.strike);
    return (
      <li key={rung.strike.toString()} className={selected ? "rung selected" : "rung"}>
        <button
          type="button"
          className="rung-button"
          aria-expanded={selected}
          onClick={() => {
            setChosen(selected ? null : rung.strike);
          }}
        >
          <span className="rung-price">{dollars(rung.strike)}</span>
          <span className="rung-hint">
            {rung.side === "sell" ? "Sell at this price" : "Buy at this price"}
            {bid !== undefined && (
              <span className="rung-bid">This week's bid {premium(bid)} per NVDA</span>
            )}
          </span>
        </button>
        {selected && (
          <Ticket
            config={config}
            view={view}
            epoch={e}
            rung={rung}
            rungs={rungs}
            tradable={tradable}
            notTradableReason={notTradableReason}
            run={run}
            busy={busy}
            onPlaced={() => {
              setChosen(null);
            }}
          />
        )}
      </li>
    );
  };

  return (
    <ol className="ladder" aria-label="This week's prices">
      {rungs.map((rung, i) => (
        <Fragment key={rung.strike.toString()}>
          {i === closeAt && <CloseLine price={dollars(e.referencePrice)} />}
          {rungRow(rung)}
        </Fragment>
      ))}
      {closeAt === rungs.length && <CloseLine price={dollars(e.referencePrice)} />}
    </ol>
  );
}

function CloseLine({ price }: { readonly price: string }) {
  return (
    <li className="close-line" aria-label={`Close ${price}`}>
      <span>Close {price}</span>
    </li>
  );
}
