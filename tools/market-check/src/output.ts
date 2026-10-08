import type { MarketCheck } from "./types.ts";

// The file's text: keys sorted at every level, so the same results always serialize the same way,
// two-space indent and a trailing newline.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function serialize(check: MarketCheck): string {
  return `${JSON.stringify(sortKeys(check), null, 2)}\n`;
}
