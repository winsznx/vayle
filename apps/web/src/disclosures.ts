// The owner's risk and legal disclosures. The landing shows the signed-off file built in, and the app
// shows /disclosures.json once it's published there. Either form is a list: plain lines, or items
// with a title and a body.

export interface Disclosure {
  // Null for a plain line.
  readonly title: string | null;
  readonly body: string;
}

function itemOf(value: unknown): Disclosure | null {
  if (typeof value === "string") return value.trim() === "" ? null : { title: null, body: value };
  if (typeof value !== "object" || value === null) return null;
  const { title, body } = value as { title?: unknown; body?: unknown };
  if (typeof title !== "string" || typeof body !== "string" || title === "" || body === "") {
    return null;
  }
  return { title, body };
}

// The list, or null when it's empty or any item isn't a line or a titled item: a broken file shows
// nothing rather than part of the disclosures.
export function parseDisclosures(value: unknown): Disclosure[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const items: Disclosure[] = [];
  for (const entry of value as unknown[]) {
    const item = itemOf(entry);
    if (item === null) return null;
    items.push(item);
  }
  return items;
}
