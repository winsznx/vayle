import type { AlertDestination } from "./config.ts";
import { WebhookFailed } from "./errors.ts";
import type { Alert, Severity } from "./rules.ts";
import type { Fetch } from "./store.ts";

const ORDER: Readonly<Record<Severity, number>> = { page: 0, warn: 1, info: 2 };
const LABEL: Readonly<Record<Severity, string>> = { page: "PAGE", warn: "WARN", info: "info" };
// The most characters Discord takes in a webhook message's content, and Telegram in a message's
// text. Text is measured in UTF-16 units, never fewer than its characters, so it fits however
// either counts them.
export const DISCORD_LIMIT = 2_000;
export const TELEGRAM_LIMIT = 4_096;

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

// The alert lines cut to `limit`: whole lines while they fit, pages first, then how many more there
// were. A first line that's too long on its own is cut short.
export function fitTo(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  for (let kept = lines.length - 1; kept > 0; kept--) {
    const cut = `${lines.slice(0, kept).join("\n")}\n…and ${lines.length - kept} more`;
    if (cut.length <= limit) return cut;
  }
  return `${cutTo(text, limit - 1)}…`;
}

export function discordContent(text: string): string {
  return fitTo(text, DISCORD_LIMIT);
}

// What the webhook gets: Discord's message shape for a Discord webhook, the payload above otherwise.
export function webhookBody(url: string, alerts: readonly Alert[]): unknown {
  const payload = alertPayload(alerts);
  return isDiscordWebhook(url) ? { content: discordContent(payload.text) } : payload;
}

// What Telegram's sendMessage gets: the alert lines as plain text, cut to its limit.
export function telegramBody(
  chatId: string,
  alerts: readonly Alert[],
): { chat_id: string; text: string; disable_web_page_preview: boolean } {
  return {
    chat_id: chatId,
    text: fitTo(alertPayload(alerts).text, TELEGRAM_LIMIT),
    disable_web_page_preview: true,
  };
}

// Sends the alerts. A refusal names the destination and its status only, since a Telegram bot's
// token sits in the URL.
export async function postAlerts(
  destination: AlertDestination,
  alerts: readonly Alert[],
  fetchFn: Fetch,
): Promise<void> {
  const [url, body, name] =
    destination.kind === "telegram"
      ? [
          `https://api.telegram.org/bot${destination.botToken}/sendMessage`,
          telegramBody(destination.chatId, alerts),
          "Telegram",
        ]
      : [destination.url, webhookBody(destination.url, alerts), "webhook"];
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new WebhookFailed(`${name} answered HTTP ${response.status}`);
}
