import { useEffect, useState } from "react";
import { parseMarketCheck, type MarketCheck } from "./marketCheck.ts";
import { loadMarketCheck } from "./marketCheckFile.ts";
import { shortError } from "./failures.ts";

export type MarketCheckState =
  | { readonly status: "loading" }
  // The build had no market check, or one this app can't read or for another chain.
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly check: MarketCheck }
  | { readonly status: "failed"; readonly reason: string };

// The market check built into the app loads as its own chunk, the first time a page needs it.
export function useMarketCheck(chainId: number): MarketCheckState {
  const [state, setState] = useState<MarketCheckState>({ status: "loading" });
  useEffect(() => {
    let ignore = false;
    loadMarketCheck().then(
      (value) => {
        if (ignore) return;
        const check = parseMarketCheck(value, chainId);
        setState(check === null ? { status: "missing" } : { status: "ready", check });
      },
      (error: unknown) => {
        if (!ignore) setState({ status: "failed", reason: shortError(error) });
      },
    );
    return () => {
      ignore = true;
    };
  }, [chainId]);
  return state;
}
