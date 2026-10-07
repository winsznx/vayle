import { WebhookFailed } from "./errors.ts";
import type { Alert, Severity } from "./rules.ts";
import type { Fetch } from "./store.ts";

const ORDER: Readonly<Record<Severity, number>> = { page: 0, warn: 1, info: 2 };
const LABEL: Readonly<Record<Severity, string>> = { page: "PAGE", warn: "WARN", info: "info" };

// The text field carries the message, which is what chat webhooks read, and the alerts ride along
// for any receiver that wants structure.
export function alertPayload(alerts: readonly Alert[]): { text: string; alerts: Alert[] } {
  const sorted = [...alerts].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return {
    text: sorted.map((a) => `[${LABEL[a.severity]}] ${a.text}`).join("\n"),
    alerts: sorted,
  };
}

export async function postAlerts(
  url: string,
  alerts: readonly Alert[],
  fetchFn: Fetch,
): Promise<void> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alertPayload(alerts)),
  });
  if (!response.ok) throw new WebhookFailed(`webhook answered HTTP ${response.status}`);
}
