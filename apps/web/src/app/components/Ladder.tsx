import { Fragment } from "react";
import { dollars, easternTime, premium } from "../format.ts";
import type { RateInputs, SheetRow } from "../rates.ts";
import { useApp } from "../state.tsx";
import type { AssetView } from "../useMarket.ts";
import { referenceLabel } from "../week.ts";
import { AssetSwitcher } from "./AssetSwitcher.tsx";

// The rate sheet: one market's targets this week, highest first, with the reference between the
// sell targets above it and the buy targets below. Each row shows what a target is paid for the
// week, as a bar against the highest rate on the sheet. Every sell target shows; a buy target shows
// only where there's a bid for it. The switcher above picks the market.

function Legend({
  asset,
  rows,
  inputs,
}: {
  readonly asset: AssetView;
  readonly rows: readonly SheetRow[];
  readonly inputs: RateInputs;
}) {
  const { bidSheet } = useApp();
  const symbol = asset.market.symbol;
  const batch = rows.some((r) => r.rate?.source === "batch");
  const maker = inputs.maker;
  const items: string[] = [];
  if (batch) items.push(`This week's batch bid, per ${symbol}`);
  if (maker !== null && rows.some((r) => r.rate?.source === "maker")) {
    items.push(`The maker's current bid, per ${symbol}, computed ${easternTime(maker.computedAt)}`);
  }
  if (items.length === 0) {
    items.push(
      inputs.readsSheet && bidSheet.status === "unavailable"
        ? "The maker's current bids can't be read right now"
        : "No bids yet",
    );
  }
  return (
    <p className="ladder-legend">
      {items.map((item) => (
        <span key={item} className="legend">
          {item}
        </span>
      ))}
    </p>
  );
}

export function Ladder(props: {
  readonly asset: AssetView;
  readonly rows: readonly SheetRow[];
  readonly inputs: RateInputs | null;
  readonly chosen: bigint | null;
  readonly onChoose: (strike: bigint) => void;
}) {
  const { asset, rows, inputs, chosen, onChoose } = props;
  const e = asset.epoch;
  const head = (
    <div className="card-head ladder-head">
      <div>
        <h2 className="h3">This week&apos;s prices</h2>
        <p className="card-sub">Above the close you set a sell target, below it a buy target.</p>
      </div>
      <AssetSwitcher />
    </div>
  );
  if (e === null || inputs === null) {
    return (
      <article className="card ladder-card">
        {head}
        <p className="empty-state">
          {asset.market.symbol}&apos;s ladder opens with its first week.
        </p>
      </article>
    );
  }
  const top = rows.reduce(
    (max, r) => (r.rate !== null && r.rate.premium > max ? r.rate.premium : max),
    0n,
  );
  // When batch bids and the maker's current bids share the sheet, each rate says which it is.
  const mixed =
    rows.some((r) => r.rate?.source === "batch") && rows.some((r) => r.rate?.source === "maker");
  const firstBuy = rows.findIndex((r) => r.rung.side === "buy");
  const closeAt = firstBuy === -1 ? rows.length : firstBuy;
  const reference = `${referenceLabel(e)} ${dollars(e.referencePrice)}`;
  const closeRow = (
    <li className="close-row" aria-label={reference}>
      <span className="close-pill num">{reference}</span>
    </li>
  );

  return (
    <article className="card ladder-card">
      {head}
      <Legend asset={asset} rows={rows} inputs={inputs} />
      <ol className="ladder-list" aria-label={`This week's prices for ${asset.market.symbol}`}>
        {rows.map(({ rung, rate }, i) => {
          const selected = chosen === rung.strike;
          const width = rate === null || top === 0n ? 0 : Number((rate.premium * 1000n) / top) / 10;
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
                    {rate === null ? (
                      <span className="row-nobid">No bid yet</span>
                    ) : (
                      <>
                        <span className="bid-track" aria-hidden="true">
                          <span className="bid-bar" style={{ width: `${Math.max(width, 4)}%` }} />
                        </span>
                        <span className="row-bid-value num">
                          {premium(rate.premium)}
                          {mixed && (
                            <span className="row-bid-source">
                              {rate.source === "batch" ? "Batch" : "Maker"}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            </Fragment>
          );
        })}
        {closeAt === rows.length && closeRow}
      </ol>
    </article>
  );
}
