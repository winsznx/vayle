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
import {
  ACCESS_REGISTRY,
  listed,
  market,
  NOW,
  nvda,
  OCT_02,
  OCT_05_OPEN,
  OCT_09,
  other,
  snapshot,
  token,
  watch,
} from "./fixtures.ts";

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
      usdgPaused: true,
      markets: [
        watch({ token: token({ paused: true, accessRegistryPaused: true, oraclePaused: true }) }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.severity]),
      [
        ["issuer-paused:usdg", "page"],
        [`issuer-paused:access-registry:${ACCESS_REGISTRY.toLowerCase()}`, "page"],
        ["issuer-paused:nvda", "page"],
        ["oracle-paused:nvda", "page"],
      ],
    );
  });

  it("alert once for an access registry that every market's token names", () => {
    // #given
    const paused = token({ accessRegistryPaused: true });
    const s = snapshot({
      markets: [
        watch({ token: paused }),
        watch({ market: other(), token: paused, listed: listed(other()) }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => a.text),
      [
        `The access registry ${ACCESS_REGISTRY} is paused. NVDA, TWO transfers fail until it resumes.`,
      ],
    );
  });

  it("alert each market's own oracle pause", () => {
    // #given: the second market's oracle is paused, NVDA's isn't
    const s = snapshot({
      markets: [
        watch(),
        watch({ market: other(), token: token({ oraclePaused: true }), listed: listed(other()) }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["oracle-paused:two"]);
  });

  it("warn about a multiplier change that hasn't taken effect", () => {
    // #given
    const s = snapshot({
      markets: [
        watch({ token: token({ newUIMultiplier: 4n * 10n ** 18n, effectiveAt: NOW + 3600 }) }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["multiplier-pending:nvda"]);
  });

  it("warn about a feed silent for over its heartbeat and an hour in the trading week", () => {
    // #given: NVDA's feed has a 24-hour heartbeat
    const s = snapshot({
      markets: [watch({ token: token({ feedUpdatedAt: NOW - 25 * 3600 - 1 }) })],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["feed-stale:nvda"]);
  });

  it("judge each feed's age against its own heartbeat", () => {
    // #given: both feeds last updated two hours ago, the second market's heartbeat is an hour
    const quiet = token({ feedUpdatedAt: NOW - 2 * 3600 - 1 });
    const hourly = other({ heartbeatSeconds: 3600 });
    const s = snapshot({
      markets: [
        watch({ token: quiet }),
        watch({ market: hourly, token: quiet, listed: listed(hourly) }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["feed-stale:two"]);
  });

  it("ignore the feed's weekend silence", () => {
    // #given: Sat 2026-10-10 12:00 UTC, the feed last updated Friday afternoon
    const saturday = 1_791_633_600;
    const s = snapshot({
      now: saturday,
      markets: [watch({ token: token({ feedUpdatedAt: saturday - 40 * 3600 }), listed: null })],
      market: null,
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(found, []);
  });

  it("page when the keeper goes quiet in the lead-up to a close", () => {
    // #given
    const now = OCT_09 - KEEPER_LEAD + 600;
    const s = snapshot({
      now,
      markets: [watch({ token: token({ feedUpdatedAt: now }) })],
      market: market({ lastSeen: now - 240 }),
    });
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
    // #given: the latest epoch still expires at the Oct 2 close
    const missing = [watch({ listed: listed(nvda(), { latestExpiry: OCT_02 }) })];
    const early = snapshot({
      now: OCT_02 + 3600,
      markets: missing.map((w) => ({ ...w, token: token({ feedUpdatedAt: OCT_02 }) })),
    });
    const late = snapshot({
      now: OCT_05_OPEN - 3600,
      markets: missing.map((w) => ({ ...w, token: token({ feedUpdatedAt: OCT_05_OPEN - 3600 }) })),
    });
    // #when
    const severities = [conditions(early), conditions(late)].map((found) =>
      found.filter((a) => a.key === "epoch-missing:nvda").map((a) => a.severity),
    );
    // #then
    assert.deepEqual(severities, [["warn"], ["page"]]);
  });

  it("alert a missing epoch only for the market missing it", () => {
    // #given: NVDA's week opened at the Oct 2 close, the second market's didn't
    const now = OCT_02 + 3600;
    const s = snapshot({
      now,
      markets: [
        watch({ token: token({ feedUpdatedAt: now }) }),
        watch({
          market: other(),
          token: token({ feedUpdatedAt: now }),
          listed: listed(other(), { latestExpiry: OCT_02 }),
        }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["epoch-missing:two"]);
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

  it("warn while one market's new positions are paused", () => {
    // #given
    const s = snapshot({ markets: [watch({ listed: listed(nvda(), { assetPaused: true }) })] });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.text]),
      [["market-paused:nvda", "New NVDA positions are paused."]],
    );
  });

  it("warn when a market's caps on the market aren't the markets file's", () => {
    // #given: a sell fill cap of 1 NVDA where the file sets 2
    const caps = { ...nvda().sell.caps, fillSize: 10n ** 18n };
    const s = snapshot({
      markets: [watch({ listed: listed(nvda(), { caps: { sell: caps, buy: nvda().buy.caps } }) })],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.severity, a.text]),
      [
        [
          "caps-differ:nvda",
          "warn",
          "NVDA's caps on the market aren't the markets file's: sell fillSize is 1000000000000000000 on the market and 2000000000000000000 in the markets file.",
        ],
      ],
    );
  });

  it("page a market whose listing isn't the markets file's, and check nothing else about it", () => {
    // #given: a paused oracle on a market listed with another strike tick
    const s = snapshot({
      markets: [
        watch({
          listing: "strikeTick is 10000000 in the registry and 5000000 in the markets file",
          token: token({ oraclePaused: true }),
        }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.severity]),
      [["listing-differs:nvda", "page"]],
    );
  });

  it("page a market that couldn't be read, and keep watching the others", () => {
    // #given: the second market's token refused its reads, and NVDA's oracle is paused
    const s = snapshot({
      markets: [
        watch({ token: token({ oraclePaused: true }) }),
        watch({
          market: other(),
          unreadable: "ContractFunctionExecutionError: execution reverted",
          token: null,
          listed: null,
        }),
      ],
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["oracle-paused:nvda", "market-unreadable:two"]);
  });
});

describe("conditions before the first close", () => {
  // The market deployed Thursday Oct 8 at 10:00 ET, before the schedule's first close on Oct 9.
  const DEPLOYED = OCT_09 - 30 * 3600;
  const FIRST = market({ latestBoundary: null, nextClose: OCT_09, deployedAt: DEPLOYED });

  function waiting(now: number, latestExpiry: number) {
    return snapshot({
      now,
      markets: [
        watch({ token: token({ feedUpdatedAt: now }), listed: listed(nvda(), { latestExpiry }) }),
      ],
      market: FIRST,
    });
  }

  it("page when a first week hasn't opened an hour after it could", () => {
    // #given: an hour and a half after the deploy, so an hour after the lookback
    const s = waiting(DEPLOYED + 1800 + 3600, 0);
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(
      found.map((a) => [a.key, a.severity]),
      [["first-epoch-missing:nvda", "page"]],
    );
  });

  it("wait out the hour after a first week could open", () => {
    // #given
    const s = waiting(DEPLOYED + 1800 + 3599, 0);
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(found, []);
  });

  it("are quiet once the first week is open", () => {
    // #given
    const s = waiting(DEPLOYED + 3 * 3600, OCT_09);
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(found, []);
  });

  it("leave a week missing after the first close to the epoch alert", () => {
    // #given: an hour after the Oct 9 close, with no week ever opened
    const now = OCT_09 + 3600;
    const s = snapshot({
      now,
      markets: [
        watch({
          token: token({ feedUpdatedAt: now }),
          listed: listed(nvda(), { latestExpiry: 0 }),
        }),
      ],
      market: market({
        latestBoundary: { close: OCT_09, creationDeadline: OCT_09 + 3 * 86_400 },
        nextClose: OCT_09 + 7 * 86_400,
        deployedAt: DEPLOYED,
        lastSeen: now - 60,
      }),
    });
    // #when
    const found = conditions(s);
    // #then
    assert.deepEqual(keys(found), ["epoch-missing:nvda"]);
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
