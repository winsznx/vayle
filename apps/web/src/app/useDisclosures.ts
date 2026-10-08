import { useEffect, useState } from "react";
import { parseDisclosures, type Disclosure } from "../disclosures.ts";

// The risk and legal disclosures are the owner's copy, published as /disclosures.json once
// approved: plain lines, or items with a title and a body. Until that file exists the app is
// read-only for new targets.

export type DisclosuresState =
  | { readonly status: "loading" }
  | { readonly status: "pending" }
  | { readonly status: "approved"; readonly items: readonly Disclosure[] };

export function useDisclosures(): DisclosuresState {
  const [state, setState] = useState<DisclosuresState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/disclosures.json", { signal: controller.signal })
      .then(async (response) => (response.ok ? parseDisclosures(await response.json()) : null))
      .then(
        (items) => {
          setState(items === null ? { status: "pending" } : { status: "approved", items });
        },
        (error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setState({ status: "pending" });
        },
      );
    return () => {
      controller.abort();
    };
  }, []);
  return state;
}
