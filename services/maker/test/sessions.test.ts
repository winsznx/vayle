import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalendarNotCovered } from "../src/errors.ts";
import { feedSessions } from "../src/sessions.ts";

function at(isoWithOffset: string): number {
  return Date.parse(isoWithOffset) / 1000;
}

describe("feedSessions", () => {
  it("joins a plain week into one run from Sunday 20:00 ET to Friday 20:00 ET", () => {
    // #when
    const around = feedSessions(at("2026-10-07T12:00:00-04:00"));
    // #then
    assert.deepEqual(around, {
      openSince: at("2026-10-04T20:00:00-04:00"),
      lastClosed: {
        opens: at("2026-09-27T20:00:00-04:00"),
        closes: at("2026-10-02T20:00:00-04:00"),
      },
    });
  });

  it("keeps a holiday Monday closed until 20:00 ET on the holiday", () => {
    // #when
    const noon = feedSessions(at("2026-09-07T12:00:00-04:00"));
    const evening = feedSessions(at("2026-09-07T20:30:00-04:00"));
    // #then
    assert.deepEqual(
      [noon, evening.openSince],
      [
        {
          openSince: null,
          lastClosed: {
            opens: at("2026-08-30T20:00:00-04:00"),
            closes: at("2026-09-04T20:00:00-04:00"),
          },
        },
        at("2026-09-07T20:00:00-04:00"),
      ],
    );
  });

  it("ends the week at Thursday's session when Friday is a holiday", () => {
    // #when
    const around = feedSessions(at("2026-12-26T12:00:00-05:00"));
    // #then
    assert.deepEqual(around, {
      openSince: null,
      lastClosed: {
        opens: at("2026-12-20T20:00:00-05:00"),
        closes: at("2026-12-24T20:00:00-05:00"),
      },
    });
  });

  it("splits the week around Thanksgiving", () => {
    // #when
    const around = feedSessions(at("2026-11-27T10:00:00-05:00"));
    // #then
    assert.deepEqual(around, {
      openSince: at("2026-11-26T20:00:00-05:00"),
      lastClosed: {
        opens: at("2026-11-22T20:00:00-05:00"),
        closes: at("2026-11-25T20:00:00-05:00"),
      },
    });
  });

  it("follows the clocks back on Sunday, Nov 1, 2026", () => {
    // #when
    const around = feedSessions(at("2026-11-01T20:30:00-05:00"));
    // #then
    assert.deepEqual(around, {
      openSince: at("2026-11-01T20:00:00-05:00"),
      lastClosed: {
        opens: at("2026-10-25T20:00:00-04:00"),
        closes: at("2026-10-30T20:00:00-04:00"),
      },
    });
  });

  it("refuses to guess past the exchange calendar's last published year", () => {
    // #then
    assert.throws(() => feedSessions(at("2029-01-10T12:00:00-05:00")), CalendarNotCovered);
  });
});
