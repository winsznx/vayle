import { useEffect, useState } from "react";

// The risk and legal disclosures are the owner's copy, published as /disclosures.json once
// approved. Until that file exists the app is read-only.

export interface Disclosure {
  readonly title: string;
  readonly body: string;
}

export type DisclosuresState =
  | { readonly status: "loading" }
  | { readonly status: "pending" }
  | { readonly status: "approved"; readonly items: readonly Disclosure[] };

function parse(value: unknown): Disclosure[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: Disclosure[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) return null;
    const { title, body } = item as { title?: unknown; body?: unknown };
    if (typeof title !== "string" || typeof body !== "string" || title === "" || body === "")
      return null;
    items.push({ title, body });
  }
  return items;
}

export function useDisclosures(): DisclosuresState {
  const [state, setState] = useState<DisclosuresState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/disclosures.json", { signal: controller.signal })
      .then(async (response) => (response.ok ? parse(await response.json()) : null))
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
