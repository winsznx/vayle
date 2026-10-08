import { formatFixed, parseFixed } from "@vayle/units";
import { useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { DisclosureList } from "../../ui/DisclosureList.tsx";
import { TokenLogo } from "../../ui/TokenLogo.tsx";
import { Ladder } from "../components/Ladder.tsx";
import { Ticket, TicketEmpty } from "../components/Ticket.tsx";
import { sheetRows } from "../rates.ts";
import { placementFor, useApp } from "../state.tsx";
import { useAsset } from "../useAsset.ts";
import { assetOf } from "../useMarket.ts";
import { ladder } from "../week.ts";

// The rate sheet and the ticket that sets a target. The market and the chosen price live in the
// URL, as ?asset= with a ticker and ?price= with a price, so any rung can be linked to and the back
// button undoes a pick.
export function TradePage() {
  const { config, view, placement, run, busy, disclosures, rates } = useApp();
  const { market, link } = useAsset();
  const [params, setParams] = useSearchParams();
  const ticketRef = useRef<HTMLDivElement>(null);
  if (view === null) return null;
  const asset = assetOf(view, market.token);
  if (asset === undefined) return null;
  const inputs = rates(asset);
  const rows =
    asset.epoch === null || inputs === null ? [] : sheetRows(ladder(asset.epoch), inputs);
  const asked = parseFixed(params.get("price") ?? "", config.usdgDecimals);
  // Only a price the sheet shows opens the ticket, so a buy target with no bid can't be set.
  const row = rows.find((r) => r.rung.strike === asked) ?? null;
  const rung = row?.rung ?? null;
  const open = placementFor(placement, asset);

  // On narrow screens the ticket sits under the ladder, so bring it into view when a rung is picked.
  const choose = (strike: bigint): void => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("price", formatFixed(strike, config.usdgDecimals));
        return next;
      },
      { replace: rung !== null },
    );
    if (window.matchMedia("(max-width: 1100px)").matches) {
      requestAnimationFrame(() => {
        ticketRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  return (
    <section className="trade" aria-label="Set a target">
      <div className="trade-ladder">
        <Ladder
          asset={asset}
          rows={rows}
          inputs={inputs}
          chosen={rung?.strike ?? null}
          onChoose={choose}
        />
      </div>
      <div ref={ticketRef} className="trade-side">
        {row === null || rung === null || asset.epoch === null ? (
          <TicketEmpty />
        ) : (
          <Ticket
            key={`${market.token}:${rung.strike.toString()}`}
            config={config}
            view={view}
            asset={asset}
            epoch={asset.epoch}
            rung={rung}
            rate={row.rate}
            rungs={rows.map((r) => r.rung)}
            tradable={open.open}
            notTradableReason={open.reason}
            run={run}
            busy={busy}
            onPlaced={() => {
              setParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  next.delete("price");
                  return next;
                },
                { replace: true },
              );
            }}
          />
        )}
      </div>
      <div className="trade-notes">
        <p className="live-now">
          <span className="live-now-list">
            Live now:
            {config.markets.map((m) => (
              <TokenLogo key={m.token} symbol={m.symbol} size="sm" label />
            ))}
          </span>{" "}
          More Stock Tokens list as they pass the market check.{" "}
          <Link className="ov-link" to={link("/markets")}>
            See every market
          </Link>
        </p>
        {disclosures.status === "approved" && (
          <section className="card" aria-labelledby="trade-risks">
            <div className="card-head">
              <h2 id="trade-risks" className="h3">
                Risks
              </h2>
            </div>
            <DisclosureList items={disclosures.items} className="disclosures" />
          </section>
        )}
      </div>
    </section>
  );
}
