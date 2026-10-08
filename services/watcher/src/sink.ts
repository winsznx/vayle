import { WebhookFailed } from "./errors.ts";
import type { Alert, Severity } from "./rules.ts";
import type { Fetch } from "./store.ts";

const ORDER: Readonly<Record<Severity, number>> = { page: 0, warn: 1, info: 2 };
const LABEL: Readonly<Record<Severity, string>> = { page: "PAGE", warn: "WARN", info: "info" };
// The most characters Discord takes in a webhook message's content. Text is measured in UTF-16
// units, never fewer than its characters, so it fits however Discord counts them.
export const DISCORD_LIMIT = 2_000;

// The text field carries the message, which is what chat webhooks read, and the alerts ride along
// for any receiver that wants structure.
export function alertPayload(alerts: readonly Alert[]): { text: string; alerts: Alert[] } {
  const sorted = [...alerts].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return {
    text: sorted.map((a) => `[${LABEL[a.severity]}] ${a.text}`).join("\n"),
    alerts: sorted,
  };
}

// A Discord webhook: discord.com or discordapp.com, under /api/webhooks/.
export function isDiscordWebhook(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { hostname, pathname } = new URL(url);
  return (
    (hostname === "discord.com" || hostname === "discordapp.com") &&
    pathname.startsWith("/api/webhooks/")
  );
}

// The first `length` units of `text`. A character outside the basic plane takes two units, and
// one cut in half is left out whole.
function cutTo(text: string, length: number): string {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// The alert lines cut to Discord's limit: whole lines while they fit, pages first, then how many
// more there were. A first line that's too long on its own is cut short.
export function discordContent(text: string): string {
  if (text.length <= DISCORD_LIMIT) return text;
  const lines = text.split("\n");
  for (let kept = lines.length - 1; kept > 0; kept--) {
    const cut = `${lines.slice(0, kept).join("\n")}\n…and ${lines.length - kept} more`;
    if (cut.length <= DISCORD_LIMIT) return cut;
  }
  return `${cutTo(text, DISCORD_LIMIT - 1)}…`;
}

// What the webhook gets: Discord's message shape for a Discord webhook, the payload above otherwise.
export function webhookBody(url: string, alerts: readonly Alert[]): unknown {
  const payload = alertPayload(alerts);
  return isDiscordWebhook(url) ? { content: discordContent(payload.text) } : payload;
}

export async function postAlerts(
  url: string,
  alerts: readonly Alert[],
  fetchFn: Fetch,
): Promise<void> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(webhookBody(url, alerts)),
  });
  if (!response.ok) throw new WebhookFailed(`webhook answered HTTP ${response.status}`);
}
