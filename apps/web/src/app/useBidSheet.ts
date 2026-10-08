import { useEffect, useState } from "react";
import { parseBidSheet, type BidSheet } from "./bidSheet.ts";
import type { AppConfig } from "./config.ts";
import { shortError } from "./failures.ts";

// The maker's bid sheet, when the build names a maker: read now, every 60 seconds while the page is
// in view, and on coming back to it. A failed refresh keeps the last sheet, whose computed time
// still shows. A sheet for another chain or market contract is never used.

export type BidSheetState =
  // The build names no maker, so rates come from batch bids only.
  | { readonly status: "off" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly sheet: BidSheet }
  | { readonly status: "unavailable"; readonly reason: string };

const REFRESH_MS = 60_000;

// The maker answered with a sheet this build can't use, as opposed to not answering.
class SheetUnusable extends Error {
  override readonly name = "SheetUnusable";
}

class SheetRequestFailed extends Error {
  override readonly name = "SheetRequestFailed";
}

async function readSheet(config: AppConfig, url: string, signal: AbortSignal): Promise<BidSheet> {
  const response = await fetch(`${url}/v1/bids`, { signal });
  if (!response.ok) throw new SheetRequestFailed(`the maker answered ${response.status}`);
  const sheet = parseBidSheet(await response.json(), config);
  if (sheet === null) {
    throw new SheetUnusable("the maker's sheet doesn't parse or is for another market");
  }
  return sheet;
}

export function useBidSheet(config: AppConfig): BidSheetState {
  const url = config.makerUrl;
  const [state, setState] = useState<BidSheetState>(
    url === null ? { status: "off" } : { status: "loading" },
  );
  useEffect(() => {
    if (url === null) return;
    const controller = new AbortController();
    let running = false;
    const load = (): void => {
      if (running || document.hidden) return;
      running = true;
      readSheet(config, url, controller.signal)
        .then(
          (sheet) => {
            if (!controller.signal.aborted) setState({ status: "ready", sheet });
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            const reason = shortError(error);
            // A sheet that can't be used is dropped, while a failed request keeps the last one.
            setState((previous) =>
              previous.status === "ready" && !(error instanceof SheetUnusable)
                ? previous
                : { status: "unavailable", reason },
            );
          },
        )
        .finally(() => {
          running = false;
        });
    };
    const onVisibility = (): void => {
      if (!document.hidden) load();
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [config, url]);
  return state;
}
