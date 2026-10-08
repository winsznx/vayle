import { TickerBadge } from "../../ui/TickerBadge.tsx";
import { useApp } from "../state.tsx";
import { useAsset } from "../useAsset.ts";

// Switches the page between the listed markets, one ticker per market, with the current one filled.
// The choice goes into the URL, so a link opens the same market.
export function AssetSwitcher() {
  const { config } = useApp();
  const { market, select } = useAsset();
  return (
    <div className="tabs asset-switch" role="group" aria-label="Stock Token">
      {config.markets.map((m) => {
        const current = m.token === market.token;
        return (
          <button
            key={m.token}
            type="button"
            className={current ? "tab is-active" : "tab"}
            aria-pressed={current}
            onClick={() => {
              select(m.symbol);
            }}
          >
            <TickerBadge symbol={m.symbol} size="sm" quiet={!current} named />
          </button>
        );
      })}
    </div>
  );
}
