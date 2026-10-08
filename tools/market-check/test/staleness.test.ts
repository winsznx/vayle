import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionOn, type Session } from "../src/sessions.ts";
import {
  judgeStaleness,
  lastAtOrBefore,
  longestGap,
  overlap,
  stalenessFigures,
} from "../src/staleness.ts";

function at(iso: string): number {
  return Date.parse(iso) / 1000;
}

function session(year: number, month: number, day: number): Session {
  const s = sessionOn({ year, month, day });
  if (s === null) throw new Error(`no session on ${year}-${month}-${day}`);
  return s;
}

// Thursday Oct 1, Friday Oct 2 and Monday Oct 5, 2026, with a weekend between.
const LOOKBACK = [session(2026, 10, 1), session(2026, 10, 2), session(2026, 10, 5)];
const CLOSES = LOOKBACK.map((s) => s.regular.end);
const NOW = at("2026-10-05T22:00:00Z");
// Thu 10:00 and 15:00 ET, Fri 13:07 ET, the Sunday 20:00 ET reopen, Mon 11:00 ET.
const UPDATES = [
  at("2026-10-01T14:00:00Z"),
  at("2026-10-01T19:00:00Z"),
  at("2026-10-02T17:07:00Z"),
  at("2026-10-05T00:00:42Z"),
  at("2026-10-05T15:00:00Z"),
];
const RULE = { heartbeatSeconds: 86_400, maxAgeAtCloseSeconds: 86_400 };

describe("overlap", () => {
  it("counts only the parts of an interval inside the windows", () => {
    // #given
    const windows = [
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ];
    // #when
    const seconds = [overlap(0, 100, windows), overlap(15, 35, windows), overlap(20, 30, windows)];
    // #then
    assert.deepEqual(seconds, [20, 10, 0]);
  });
});

describe("longestGap", () => {
  it("counts the lookback's start and the pinned time as the ends of the first and last gaps", () => {
    // #given
    const windows = [{ start: 0, end: 100 }];
    // #when
    const gaps = [longestGap([40], windows, 0, 100), longestGap([], windows, 0, 100)];
    // #then
    assert.deepEqual(gaps, [60, 100]);
  });
});

describe("lastAtOrBefore", () => {
  it("finds the last update at or before a time", () => {
    // #given
    const updates = [10, 20, 30];
    // #when
    const found = [5, 10, 25, 30, 99].map((t) => lastAtOrBefore(updates, t));
    // #then
    assert.deepEqual(found, [null, 10, 20, 30, 30]);
  });
});

describe("stalenessFigures", () => {
  it("measures regular-hours gaps across nights and the weekend", () => {
    // #given
    // Thu 15:00 to Fri 13:07 ET is an hour on Thursday and 3h37m on Friday, 16,620 s. The longest
    // is Monday 11:00 ET to the close, 18,000 s.
    const updates = UPDATES;
    // #when
    const figures = stalenessFigures(updates, LOOKBACK, NOW);
    // #then
    assert.equal(figures.maxRegularHoursGapSeconds, 18_000);
  });

  it("measures market-hours gaps over the feed's own sessions", () => {
    // #given
    // Thu 15:00 ET to Fri 13:07 ET is all inside the feed's sessions: 22h07m, 79,620 s. Friday
    // 13:07 ET to the Sunday reopen counts 6h53m on Friday and 42 s on Sunday.
    const updates = UPDATES;
    // #when
    const figures = stalenessFigures(updates, LOOKBACK, NOW);
    // #then
    assert.equal(figures.maxMarketHoursGapSeconds, 79_620);
  });

  it("ages each close's round", () => {
    // #given
    const updates = UPDATES;
    // #when
    const figures = stalenessFigures(updates, LOOKBACK, NOW);
    // #then
    assert.deepEqual(figures.agesAtClose, [3_600, 10_380, 18_000]);
  });
});

describe("judgeStaleness", () => {
  it("passes gaps within the heartbeat and closes with fresh rounds", () => {
    // #given
    const figures = stalenessFigures(UPDATES, LOOKBACK, NOW);
    // #when
    const verdict = judgeStaleness(figures, CLOSES, RULE);
    // #then
    assert.deepEqual(verdict, { pass: true, reason: "" });
  });

  it("fails a market-hours gap longer than the feed's heartbeat", () => {
    // #given
    const figures = stalenessFigures(UPDATES, LOOKBACK, NOW);
    // #when
    const verdict = judgeStaleness(figures, CLOSES, { ...RULE, heartbeatSeconds: 3_600 });
    // #then
    assert.deepEqual(verdict, {
      pass: false,
      reason: "79620 s of market hours passed without an update, over the 3600 s heartbeat",
    });
  });

  it("fails a close whose round is more than a day old", () => {
    // #given
    // Without Friday's update, the round at Friday's close is Thursday 15:00 ET's, 25 hours old.
    const updates = UPDATES.filter((t) => t !== at("2026-10-02T17:07:00Z"));
    const figures = stalenessFigures(updates, LOOKBACK, NOW);
    // #when
    const verdict = judgeStaleness(figures, CLOSES, RULE);
    // #then
    assert.deepEqual(verdict, {
      pass: false,
      reason: "the round at the 2026-10-02T20:00:00.000Z close was 90000 s old, over 86400 s",
    });
  });

  it("fails a close with no round at or before it", () => {
    // #given
    const [firstClose] = CLOSES;
    if (firstClose === undefined) throw new Error("no closes");
    const updates = UPDATES.filter((t) => t > firstClose);
    const figures = stalenessFigures(updates, LOOKBACK, NOW);
    // #when
    const verdict = judgeStaleness(figures, CLOSES, RULE);
    // #then
    assert.deepEqual(verdict, {
      pass: false,
      reason: "no round at or before the 2026-10-01T20:00:00.000Z close",
    });
  });
});
