import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completedSessions, sessionOn } from "../src/sessions.ts";

function at(iso: string): number {
  return Date.parse(iso) / 1000;
}

describe("sessionOn", () => {
  it("runs 09:30 to 16:00 ET, with the feed from 20:00 ET the evening before", () => {
    // #given
    const date = { year: 2026, month: 10, day: 7 };
    // #when
    const session = sessionOn(date);
    // #then
    assert.deepEqual(session, {
      regular: { start: at("2026-10-07T13:30:00Z"), end: at("2026-10-07T20:00:00Z") },
      feed: { start: at("2026-10-07T00:00:00Z"), end: at("2026-10-08T00:00:00Z") },
    });
  });

  it("closes at 13:00 ET on an early-close day in standard time", () => {
    // #given
    const date = { year: 2026, month: 11, day: 27 };
    // #when
    const session = sessionOn(date);
    // #then
    assert.deepEqual(session, {
      regular: { start: at("2026-11-27T14:30:00Z"), end: at("2026-11-27T18:00:00Z") },
      feed: { start: at("2026-11-27T01:00:00Z"), end: at("2026-11-28T01:00:00Z") },
    });
  });

  it("has no session on an exchange holiday", () => {
    // #given
    const thanksgiving = { year: 2026, month: 11, day: 26 };
    // #when
    const session = sessionOn(thanksgiving);
    // #then
    assert.equal(session, null);
  });
});

describe("completedSessions", () => {
  it("counts today's session once its close has passed", () => {
    // #given
    const evening = at("2026-10-07T22:40:00Z");
    // #when
    const closes = completedSessions(evening, 5).map((s) => s.regular.end);
    // #then
    assert.deepEqual(closes, [
      at("2026-10-01T20:00:00Z"),
      at("2026-10-02T20:00:00Z"),
      at("2026-10-05T20:00:00Z"),
      at("2026-10-06T20:00:00Z"),
      at("2026-10-07T20:00:00Z"),
    ]);
  });

  it("leaves out a session that hasn't closed yet", () => {
    // #given
    const afternoon = at("2026-10-07T19:00:00Z");
    // #when
    const closes = completedSessions(afternoon, 2).map((s) => s.regular.end);
    // #then
    assert.deepEqual(closes, [at("2026-10-05T20:00:00Z"), at("2026-10-06T20:00:00Z")]);
  });

  it("skips weekends and holidays", () => {
    // #given
    const afterLaborDay = at("2026-09-08T21:00:00Z");
    // #when
    const closes = completedSessions(afterLaborDay, 3).map((s) => s.regular.end);
    // #then
    assert.deepEqual(closes, [
      at("2026-09-03T20:00:00Z"),
      at("2026-09-04T20:00:00Z"),
      at("2026-09-08T20:00:00Z"),
    ]);
  });
});
