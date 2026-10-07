import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChainEvent } from "../src/events.ts";
import {
  conditions,
  eventAlerts,
  inTradingWeek,
  KEEPER_LEAD,
  REPAGE_INTERVAL,
  transitions,
  type Alert,
} from "../src/rules.ts";
import { market, NOW, OCT_02, OCT_05_OPEN, OCT_09, snapshot } from "./fixtures.ts";

function keys(alerts: readonly Alert[]): string[] {
  return alerts.map((a) => a.key);
}

describe("conditions", () => {
  it("are quiet on a normal Wednesday", () => {
    // #when
    const found = conditions(snapshot());
    // #then
    assert.deepEqual(found, []);
  });

  it("page for every issuer pause and the oracle flag", () => {
    // #given
    const s = snapshot({
      issuer: {
        nvdaPaused: true,
        accessRegistryPaused: true,
        usdgPaused: true,
        oraclePaused: true,
      },
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.severity]),
      [
        ["issuer-paused:nvda", "page"],
        ["issuer-paused:access-registry", "page"],
        ["issuer-paused:usdg", "page"],
        ["oracle-paused:nvda", "page"],
      ],
    );
  });

  it("warn about a multiplier change that hasn't taken effect", () => {
    // #given
    const s = snapshot({ issuer: { newUIMultiplier: 4n * 10n ** 18n, effectiveAt: NOW + 3600 } });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["multiplier-pending:nvda"]);
  });

  it("warn about a feed silent for over 25 hours in the trading week", () => {
    // #given
    const s = snapshot({ feedUpdatedAt: NOW - 25 * 3600 - 1 });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["feed-stale:nvda"]);
  });

  it("ignore the feed's weekend silence", () => {
    // #given: Sat 2026-10-10 12:00 UTC, the feed last updated Friday afternoon
    const saturday = 1_791_633_600;
    const s = snapshot({ now: saturday, feedUpdatedAt: saturday - 40 * 3600, market: null });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(found, []);
  });

  it("page when the keeper goes quiet in the lead-up to a close", () => {
    // #given
    const now = OCT_09 - KEEPER_LEAD + 600;
    const s = snapshot({ now, feedUpdatedAt: now, market: market({ lastSeen: now - 240 }) });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["keeper-silent"]);
  });

  it("don't need the keeper mid-week", () => {
    // #given
    const s = snapshot({ market: market({ lastSeen: NOW - 3 * 86_400 }) });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(found, []);
  });

  it("warn about a missing epoch, then page six hours before its deadline", () => {
    // #given
    const missing = market({ epochOpenedAtLatest: false });
    const early = snapshot({ now: OCT_02 + 3600, feedUpdatedAt: OCT_02, market: missing });
    const late = snapshot({
      now: OCT_05_OPEN - 3600,
      feedUpdatedAt: OCT_05_OPEN - 3600,
      market: missing,
    });
    // #when
    const severities = [conditions(early), conditions(late)].map((found) =>
      found.filter((a) => a.key === "epoch-missing:nvda").map((a) => a.severity),
    );
    // #then
    assert.deepEqual(severities, [["warn"], ["page"]]);
  });

  it("warn when fewer than five boundaries are scheduled ahead", () => {
    // #given
    const s = snapshot({ market: market({ boundariesAhead: 4 }) });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["calendar-runway"]);
  });

  it("page while a halt is active and warn while new positions are paused", () => {
    // #given
    const s = snapshot({ market: market({ haltedUntil: NOW + 3600, paused: true }) });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.severity]),
      [
        ["halt-active", "page"],
        ["market-paused", "warn"],
      ],
    );
  });
});

describe("inTradingWeek", () => {
  it("closes at Friday 20:00 ET and reopens Sunday 21:00 ET, in both DST regimes", () => {
    // #given: Fri 19:59 and 20:00 EDT, Sun 20:59 and 21:00 EST
    const times = [1_791_590_340, 1_791_590_400, 1_794_189_540, 1_794_189_600];
    // #when
    const open = times.map(inTradingWeek);
    // #then
    assert.deepEqual(open, [true, false, false, true]);
  });
});

describe("transitions", () => {
  const halt: Alert = { key: "halt-active", severity: "page", text: "halted" };
  const runway: Alert = { key: "calendar-runway", severity: "warn", text: "runway" };

  it("alert once when a condition appears", () => {
    // #when
    const { alerts, active } = transitions({}, [runway], NOW);
    // #then
    assert.deepEqual(
      [keys(alerts), active["calendar-runway"]],
      [["calendar-runway"], { severity: "warn", since: NOW, lastSent: NOW }],
    );
  });

  it("stay quiet while a warning persists", () => {
    // #given
    const previous = {
      "calendar-runway": { severity: "warn" as const, since: NOW - 86_400, lastSent: NOW - 86_400 },
    };
    // #when
    const { alerts } = transitions(previous, [runway], NOW);
    // #then
    assert.deepEqual(alerts, []);
  });

  it("repeat a page every hour while it persists", () => {
    // #given
    const previous = {
      "halt-active": {
        severity: "page" as const,
        since: NOW - 2 * 3600,
        lastSent: NOW - REPAGE_INTERVAL,
      },
    };
    // #when
    const { alerts, active } = transitions(previous, [halt], NOW);
    // #then
    assert.deepEqual([keys(alerts), active["halt-active"]?.lastSent], [["halt-active"], NOW]);
  });

  it("alert again when a condition escalates", () => {
    // #given
    const previous = {
      "epoch-missing:nvda": { severity: "warn" as const, since: NOW - 600, lastSent: NOW - 600 },
    };
    const escalated: Alert = { key: "epoch-missing:nvda", severity: "page", text: "late" };
    // #when
    const { alerts, active } = transitions(previous, [escalated], NOW);
    // #then
    assert.deepEqual(
      [keys(alerts), active["epoch-missing:nvda"]?.since],
      [["epoch-missing:nvda"], NOW - 600],
    );
  });

  it("send one notice when a condition clears", () => {
    // #given
    const previous = {
      "halt-active": { severity: "page" as const, since: NOW - 600, lastSent: NOW - 600 },
    };
    // #when
    const { alerts, active } = transitions(previous, [], NOW);
    // #then
    assert.deepEqual(
      [alerts.map((a) => [a.key, a.severity]), active],
      [[["halt-active", "info"]], {}],
    );
  });
});

describe("eventAlerts", () => {
  const tx = "0x34f9aa77506ab96c5b8e3e5a9798ffab232533ae61759682c5b091ac4efb4a4f";
  function event(name: string, args: Record<string, unknown>, logIndex = 0): ChainEvent {
    return {
      name,
      address: "0x0000000000000000000000000000000000000001",
      blockNumber: 1n,
      logIndex,
      transactionHash: tx,
      args,
    };
  }

  it("turn each watched log into one alert keyed by transaction and log index", () => {
    // #given
    const events = [event("HaltStarted", { start: 1n, end: 2n }, 3)];
    // #when
    const alerts = eventAlerts(events, "https://explorer.example");
    // #then
    assert.deepEqual(alerts, [
      {
        key: `event:${tx}:3`,
        severity: "page",
        text: `HaltStarted {"start":"1","end":"2"} https://explorer.example/tx/${tx}`,
      },
    ]);
  });

  it("warn when the owner changes which makers may bid into batches", () => {
    // #given
    const events = [
      event("BatchBidderSet", {
        maker: "0x00000000000000000000000000000000000000bb",
        allowed: true,
      }),
    ];
    // #when
    const alerts = eventAlerts(events, "https://explorer.example");
    // #then
    assert.deepEqual(
      alerts.map((a) => a.severity),
      ["warn"],
    );
  });

  it("skip routine logs and fills by the team's maker", () => {
    // #given
    const events = [
      event("TransferSingle", {}),
      event("QuoteFilled", { teamOperated: true }),
      event("QuoteFilled", { teamOperated: false }, 1),
    ];
    // #when
    const alerts = eventAlerts(events, "https://explorer.example");
    // #then
    assert.deepEqual(keys(alerts), [`event:${tx}:1`]);
  });
});
