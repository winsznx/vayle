import { Fragment } from "react";
import { dollars, premium } from "../format.ts";
import type { MarketView } from "../useMarket.ts";
import type { Rung } from "../week.ts";

// This week's strikes, highest first, with the close between the sell rungs above it and the buy
// rungs below. Each rung shows the week's best bid as a bar against the highest bid on the ladder.
export function Ladder(props: {
  readonly view: MarketView;
  readonly rungs: readonly Rung[];
  readonly chosen: bigint | null;
  readonly onChoose: (strike: bigint) => void;
}) {
  const { view, rungs, chosen, onChoose } = props;
  const e = view.epoch;
  if (e === null) {
    return (
      <article className="card ladder-card">
        <div className="card-head">
          <h2 className="h3">This week&apos;s prices</h2>
        </div>
        <p className="empty-state">The ladder opens at the next weekly close.</p>
      </article>
    );
  }
  const top = [...view.bids.values()].reduce((a, b) => (b > a ? b : a), 0n);
  const firstBuy = rungs.findIndex((r) => r.side === "buy");
  const closeAt = firstBuy === -1 ? rungs.length : firstBuy;
  const closeRow = (
    <li className="close-row" aria-label={`Close ${dollars(e.referencePrice)}`}>
      <span className="close-pill num">Close {dollars(e.referencePrice)}</span>
    </li>
  );

  return (
    <article className="card ladder-card">
      <div className="card-head">
        <div>
          <h2 className="h3">This week&apos;s prices</h2>
          <p className="card-sub">Above the close you sell, below it you buy.</p>
        </div>
        <span className="legend">Bid this week, per NVDA</span>
      </div>
      <ol className="ladder-list" aria-label="This week's prices">
        {rungs.map((rung, i) => {
          const bid = view.bids.get(rung.strike);
          const selected = chosen === rung.strike;
          const width = bid === undefined || top === 0n ? 0 : Number((bid * 1000n) / top) / 10;
          return (
            <Fragment key={rung.strike.toString()}>
              {i === closeAt && closeRow}
              <li>
                <button
                  type="button"
                  className={selected ? "ladder-row is-chosen" : "ladder-row"}
                  aria-pressed={selected}
                  onClick={() => {
                    onChoose(rung.strike);
                  }}
                >
                  <span className="row-price num">{dollars(rung.strike)}</span>
                  <span
                    className={rung.side === "sell" ? "row-side side-sell" : "row-side side-buy"}
                  >
                    {rung.side === "sell" ? "Sell" : "Buy"}
                  </span>
                  <span className="row-bid">
                    {bid === undefined ? (
                      <span className="row-nobid">No bid yet</span>
                    ) : (
                      <>
                        <span className="bid-track" aria-hidden="true">
                          <span className="bid-bar" style={{ width: `${Math.max(width, 4)}%` }} />
                        </span>
                        <span className="row-bid-value num">{premium(bid)}</span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
        {closeAt === rungs.length && closeRow}
      </ol>
    </article>
  );
}
