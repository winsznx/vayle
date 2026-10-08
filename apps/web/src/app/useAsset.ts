import type { Market } from "@vayle/markets";
import { useSearchParams } from "react-router";
import { ASSET_PARAM, selectMarket, withAsset } from "./assets.ts";
import { useApp } from "./state.tsx";

export interface AssetChoice {
  readonly market: Market;
  // The ticker the URL names, or null while the page shows the first market by default.
  readonly asked: string | null;
  // Switches the page to another market. A chosen price belongs to the old market, so it goes.
  readonly select: (symbol: string) => void;
  // The path with this choice kept in it.
  readonly link: (path: string) => string;
}

// The market the page shows, from the URL.
export function useAsset(): AssetChoice {
  const { config } = useApp();
  const [params, setParams] = useSearchParams();
  const market = selectMarket(config.markets, params.get(ASSET_PARAM));
  const asked = params.has(ASSET_PARAM) ? market.symbol : null;
  return {
    market,
    asked,
    select: (symbol) => {
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set(ASSET_PARAM, symbol);
        next.delete("price");
        return next;
      });
    },
    link: (path) => withAsset(path, asked),
  };
}
