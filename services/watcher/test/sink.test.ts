import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Alert } from "../src/rules.ts";
import {
  alertPayload,
  DISCORD_LIMIT,
  discordContent,
  isDiscordWebhook,
  postAlerts,
  TELEGRAM_LIMIT,
  telegramBody,
  webhookBody,
} from "../src/sink.ts";

const DISCORD = "https://discord.com/api/webhooks/1234567890/token-part";
const ALERTS: Alert[] = [
  { key: "a", severity: "info", text: "listed" },
  { key: "b", severity: "page", text: "halted" },
  { key: "c", severity: "warn", text: "runway" },
];

// `count` page alerts of about a hundred characters each.
function many(count: number): Alert[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `event:${i}`,
    severity: "page" as const,
    text: `HaltStarted number ${i} ${"x".repeat(80)}`,
  }));
}

describe("alertPayload", () => {
  it("puts pages first and labels each line", () => {
    // #when
    const payload = alertPayload(ALERTS);
    // #then
    assert.equal(payload.text, "[PAGE] halted\n[WARN] runway\n[info] listed");
  });
});

describe("isDiscordWebhook", () => {
  it("knows a webhook on discord.com or discordapp.com", () => {
    // #when
    const found = [DISCORD, "https://discordapp.com/api/webhooks/1/x"].map(isDiscordWebhook);
    // #then
    assert.deepEqual(found, [true, true]);
  });

  it("takes no other host or path for one", () => {
    // #when
    const found = [
      "https://discord.com/channels/1/2",
      "https://hooks.example/api/webhooks/1/x",
      "https://discord.com.example/api/webhooks/1/x",
      "not a url",
    ].map(isDiscordWebhook);
    // #then
    assert.deepEqual(found, [false, false, false, false]);
  });
});

describe("webhookBody", () => {
  it("sends Discord the alert lines as its content", () => {
    // #when
    const body = webhookBody(DISCORD, ALERTS);
    // #then
    assert.deepEqual(body, { content: "[PAGE] halted\n[WARN] runway\n[info] listed" });
  });

  it("sends any other webhook the text and the alerts", () => {
    // #when
    const body = webhookBody("https://hooks.example/alerts", ALERTS);
    // #then
    assert.deepEqual(body, alertPayload(ALERTS));
  });
});

describe("discordContent", () => {
  it("keeps whole lines within 2,000 characters and counts the rest", () => {
    // #given: 40 alerts of about 110 characters each
    const text = alertPayload(many(40)).text;
    // #when
    const content = discordContent(text);
    // #then
    const lines = content.split("\n");
    assert.deepEqual(
      [
        content.length <= DISCORD_LIMIT,
        lines.at(-1),
        text.startsWith(lines.slice(0, -1).join("\n")),
      ],
      [true, `…and ${40 - (lines.length - 1)} more`, true],
    );
  });

  it("cuts a single line that's too long on its own", () => {
    // #given
    const text = "y".repeat(3000);
    // #when
    const content = discordContent(text);
    // #then
    assert.deepEqual([content.length, content.endsWith("…")], [DISCORD_LIMIT, true]);
  });

  it("doesn't cut a character in half", () => {
    // #given: a character outside the basic plane across the cut
    const text = `${"y".repeat(DISCORD_LIMIT - 2)}\u{1F4C8}${"z".repeat(10)}`;
    // #when
    const content = discordContent(text);
    // #then
    assert.equal(content, `${"y".repeat(DISCORD_LIMIT - 2)}…`);
  });

  it("leaves text that fits alone", () => {
    // #when
    const content = discordContent("[PAGE] halted");
    // #then
    assert.equal(content, "[PAGE] halted");
  });
});

describe("postAlerts", () => {
  it("posts Discord's shape to a Discord webhook", async () => {
    // #given
    const bodies: unknown[] = [];
    const fetchFn = (_url: string, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    // #when
    await postAlerts({ kind: "webhook", url: DISCORD }, many(30), fetchFn);
    // #then
    const [body] = bodies as [{ content: string }];
    assert.deepEqual(
      [Object.keys(body), body.content.length <= DISCORD_LIMIT],
      [["content"], true],
    );
  });
});

describe("Telegram alerts", () => {
  it("sends the alert lines, pages first, as plain text to the chat", () => {
    // #when
    const body = telegramBody("-100123", ALERTS);
    // #then
    assert.deepEqual(body, {
      chat_id: "-100123",
      text: "[PAGE] halted\n[WARN] runway\n[info] listed",
      disable_web_page_preview: true,
    });
  });

  it("keeps a long batch under Telegram's limit", () => {
    // #when
    const body = telegramBody("1", many(80));
    // #then
    assert.ok(body.text.length <= TELEGRAM_LIMIT);
  });

  it("posts to the bot's sendMessage and names Telegram, not the URL, when refused", async () => {
    // #given
    const urls: string[] = [];
    const fetchFn = (url: string): Promise<Response> => {
      urls.push(url);
      return Promise.resolve(new Response(null, { status: 401 }));
    };
    // #when
    const attempt = postAlerts(
      { kind: "telegram", botToken: "123:abc", chatId: "1" },
      ALERTS,
      fetchFn,
    );
    // #then
    await assert.rejects(attempt, (error: Error) => error.message === "Telegram answered HTTP 401");
    assert.deepEqual(urls, ["https://api.telegram.org/bot123:abc/sendMessage"]);
  });
});
