import { formatFixed, parseFixed } from "@vayle/units";
import { useRef } from "react";
import { useSearchParams } from "react-router";
import { Ladder } from "../components/Ladder.tsx";
import { Ticket, TicketEmpty } from "../components/Ticket.tsx";
import { useApp } from "../state.tsx";
import { ladder } from "../week.ts";

// The ladder and the order ticket. The chosen price lives in the URL, ?price=245, so any rung can be
// linked to and the back button undoes a pick.
export function TradePage() {
  const { config, view, placement, run, busy } = useApp();
  const [params, setParams] = useSearchParams();
  const ticketRef = useRef<HTMLDivElement>(null);
  if (view === null) return null;
  const rungs = view.epoch === null ? [] : ladder(view.epoch);
  const asked = parseFixed(params.get("price") ?? "", config.usdgDecimals);
  const rung = rungs.find((r) => r.strike === asked) ?? null;

  // On narrow screens the ticket sits under the ladder, so bring it into view when a rung is picked.
  const choose = (strike: bigint): void => {
    setParams({ price: formatFixed(strike, config.usdgDecimals) }, { replace: rung !== null });
    if (window.matchMedia("(max-width: 1100px)").matches) {
      requestAnimationFrame(() => {
        ticketRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };

  return (
    <section className="trade" aria-label="Place an order">
      <Ladder view={view} rungs={rungs} chosen={rung?.strike ?? null} onChoose={choose} />
      <div ref={ticketRef} className="trade-side">
        {rung === null || view.epoch === null ? (
          <TicketEmpty />
        ) : (
          <Ticket
            key={rung.strike.toString()}
            config={config}
            view={view}
            epoch={view.epoch}
            rung={rung}
            rungs={rungs}
            tradable={placement.open}
            notTradableReason={placement.reason}
            run={run}
            busy={busy}
            onPlaced={() => {
              setParams({}, { replace: true });
            }}
          />
        )}
      </div>
    </section>
  );
}
