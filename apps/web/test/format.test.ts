import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  amountOf,
  dollars,
  easternClock,
  easternDate,
  easternDay,
  easternMonthDay,
  easternTime,
  premium,
  step,
  unitOf,
} from "../src/app/format.ts";

describe("format", () => {
  it("shows prices in dollars and cents, cut rather than rounded", () => {
    // #then
    assert.deepEqual([dollars(245_000_000n), dollars(1_234_567_899n)], ["$245.00", "$1,234.56"]);
  });

  it("keeps four places for a per-token premium", () => {
    // #then
    assert.equal(premium(2_471_300n), "$2.4713");
  });

  it("shows a market's token amounts to its lot, with its ticker", () => {
    // #given
    const unit = unitOf({ symbol: "ABC", decimals: 18, lot: 10n ** 16n });
    // #then
    assert.equal(amountOf(1_500_000_000_000_000_000n, unit), "1.50 ABC");
  });

  it("keeps enough places to show a smaller lot exactly", () => {
    // #given
    const unit = unitOf({ symbol: "ABC", decimals: 18, lot: 10n ** 14n });
    // #then
    assert.equal(amountOf(25n * 10n ** 14n, unit), "0.0025 ABC");
  });

  it("writes a price step with every digit it has", () => {
    // #then
    assert.deepEqual([step(100n), step(5_000_000n), step(500_000n)], ["$0.0001", "$5.00", "$0.50"]);
  });

  it("reads US Eastern time from the calendar, labeled ET, in daylight and standard time", () => {
    // #given 02:00 UTC on Oct 10 is still Friday evening in daylight time, and 03:30 UTC on Nov 2
    // is Sunday evening once standard time has begun
    const daylight = Date.UTC(2026, 9, 10, 2) / 1000;
    const standard = Date.UTC(2026, 10, 2, 3, 30) / 1000;
    // #then
    assert.deepEqual(
      [easternTime(daylight), easternTime(standard)],
      ["Fri, Oct 9, 10:00\u00a0PM\u00a0ET", "Sun, Nov 1, 10:30\u00a0PM\u00a0ET"],
    );
  });

  it("gives the Eastern date, day and month for dates near midnight UTC", () => {
    // #given 03:00 UTC on Jan 1 is still Dec 31 in New York
    const lateNewYearsEve = Date.UTC(2027, 0, 1, 3) / 1000;
    // #then
    assert.deepEqual(
      [
        easternDate(lateNewYearsEve),
        easternDay(lateNewYearsEve, 2026),
        easternDay(lateNewYearsEve, 2027),
        easternMonthDay(lateNewYearsEve),
      ],
      ["2026-12-31", "Thu, Dec 31", "Thu, Dec 31, 2026", "Dec 31"],
    );
  });

  it("keeps a time and its zone together so it never wraps across lines", () => {
    // #given
    const fridayClose = 1_791_576_000;
    // #then
    assert.deepEqual(
      [easternTime(fridayClose), easternClock(fridayClose)],
      ["Fri, Oct 9, 4:00\u00a0PM\u00a0ET", "4:00\u00a0PM\u00a0ET"],
    );
  });
});
