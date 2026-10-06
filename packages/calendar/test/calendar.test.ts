import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import {
  CalendarYearNotCovered,
  coveredYears,
  isPlausibleClose,
  sessionClose,
  weeklyBoundariesAfter,
  weeklyBoundary,
} from "../src/index.ts";
import { addDays, fromDays, isoDate, parseIsoDate, weekday, type CivilDate } from "../src/civil.ts";
import { easternOffsetHours } from "../src/dst.ts";
import { NYSE_EARLY_CLOSES, NYSE_HOLIDAYS } from "../src/nyse.ts";
import { ruleBasedHolidays } from "../src/rules.ts";

const DAY = 86_400;
const HOUR = 3_600;

function date(text: string): CivilDate {
  return parseIsoDate(text);
}

const coveredDate = fc
  .integer({ min: 0, max: 365 * 3 - 1 })
  .map((offset) => addDays(date("2026-01-01"), offset));

describe("published table", () => {
  it("matches the rule-based holidays in every covered year", () => {
    // #given
    const years = coveredYears();
    // #when
    const mismatches = years.filter((year) => {
      const published = [...(NYSE_HOLIDAYS[year] ?? [])].sort();
      const ruled = ruleBasedHolidays(year).map(isoDate).sort();
      return JSON.stringify(published) !== JSON.stringify(ruled);
    });
    // #then
    assert.deepEqual(mismatches, []);
  });

  it("lists only weekdays, and no early close on a holiday", () => {
    // #given
    const all = coveredYears().flatMap((year) => [
      ...(NYSE_HOLIDAYS[year] ?? []),
      ...(NYSE_EARLY_CLOSES[year] ?? []),
    ]);
    const holidays = new Set(coveredYears().flatMap((year) => NYSE_HOLIDAYS[year] ?? []));
    // #when
    const weekends = all.filter((d) => [0, 6].includes(weekday(date(d))));
    const overlaps = coveredYears()
      .flatMap((year) => NYSE_EARLY_CLOSES[year] ?? [])
      .filter((d) => holidays.has(d));
    // #then
    assert.deepEqual([weekends, overlaps], [[], []]);
  });
});

describe("sessionClose", () => {
  it("returns the published closes in UTC across both DST regimes and early closes", () => {
    // #given
    const cases: [string, number | null][] = [
      ["2026-10-09", 1_791_576_000],
      ["2026-11-27", 1_795_802_400],
      ["2026-12-24", 1_798_135_200],
      ["2026-12-25", null],
      ["2026-12-31", 1_798_750_800],
      ["2027-03-19", 1_805_486_400],
      ["2026-10-10", null],
    ];
    // #when
    const results = cases.map(([d]) => sessionClose(date(d)));
    // #then
    assert.deepEqual(
      results,
      cases.map(([, expected]) => expected),
    );
  });

  it("fails closed for a year the exchange hasn't published", () => {
    // #when
    const outcomes = [date("2025-06-02"), date("2029-06-04")].map((d) => {
      try {
        sessionClose(d);
        return "computed";
      } catch (error) {
        return error instanceof CalendarYearNotCovered ? "not covered" : "other";
      }
    });
    // #then
    assert.deepEqual(outcomes, ["not covered", "not covered"]);
  });

  it("closes only on trading days, at a plausible hour that follows DST and early closes", () => {
    fc.assert(
      fc.property(coveredDate, (d) => {
        // #given
        const holidays = new Set(NYSE_HOLIDAYS[d.year] ?? []);
        const early = new Set(NYSE_EARLY_CLOSES[d.year] ?? []);
        const trades = ![0, 6].includes(weekday(d)) && !holidays.has(isoDate(d));
        // #when
        const close = sessionClose(d);
        // #then
        if (!trades) return close === null;
        const expectedHourUtc = (early.has(isoDate(d)) ? 13 : 16) - easternOffsetHours(d);
        return (
          close !== null &&
          isPlausibleClose(close) &&
          (close % DAY) / HOUR === expectedHourUtc &&
          isoDate(fromDays(Math.floor(close / DAY))) === isoDate(d)
        );
      }),
    );
  });
});

describe("easternOffsetHours", () => {
  it("switches on the second Sunday of March and the first Sunday of November", () => {
    // #when
    const offsets = ["2026-10-30", "2026-11-06", "2027-03-12", "2027-03-19"].map((d) =>
      easternOffsetHours(date(d)),
    );
    // #then
    assert.deepEqual(offsets, [-4, -5, -5, -4]);
  });
});

describe("weeklyBoundary", () => {
  it("rolls back to Thursday when Friday is a holiday", () => {
    // #when
    const results = [
      weeklyBoundary(date("2026-12-21")),
      weeklyBoundary(date("2026-12-28")),
      weeklyBoundary(date("2027-03-22")),
      weeklyBoundary(date("2027-12-27")),
    ];
    // #then
    assert.deepEqual(results, [1_798_135_200, 1_798_750_800, 1_806_004_800, 1_830_286_800]);
  });

  it("is the latest session close of its Monday-to-Friday week", () => {
    // Weeks that lie entirely inside the published years: Monday 2026-01-05 to Monday 2028-12-25.
    const dayInCoveredWeek = fc
      .record({ week: fc.integer({ min: 0, max: 155 }), day: fc.integer({ min: 0, max: 6 }) })
      .map(({ week, day }) => addDays(date("2026-01-05"), week * 7 + day));
    fc.assert(
      fc.property(dayInCoveredWeek, (d) => {
        // #given
        const monday = addDays(d, -((weekday(d) + 6) % 7));
        const closes = [0, 1, 2, 3, 4]
          .map((offset) => sessionClose(addDays(monday, offset)))
          .filter((c): c is number => c !== null);
        // #when
        const boundary = weeklyBoundary(d);
        // #then
        return boundary === Math.max(...closes);
      }),
    );
  });
});

describe("weeklyBoundariesAfter", () => {
  it("lists the next boundaries strictly after a time", () => {
    // #given: the block time of the committed chain facts
    const after = 1_791_321_731;
    // #when
    const boundaries = weeklyBoundariesAfter(after, 3);
    // #then
    assert.deepEqual(boundaries, [1_791_576_000, 1_792_180_800, 1_792_785_600]);
  });

  it("keeps consecutive boundaries six to eight days apart, give or take the session hours", () => {
    // #given
    const start = 1_767_225_600;
    // #when
    const boundaries = weeklyBoundariesAfter(start, 150);
    // #then
    const gaps = boundaries.slice(1).map((b, i) => b - (boundaries[i] ?? 0));
    assert.ok(boundaries.every(isPlausibleClose));
    assert.ok(gaps.every((gap) => gap >= 6 * DAY - 4 * HOUR && gap <= 8 * DAY + 4 * HOUR));
  });
});

describe("parseIsoDate", () => {
  it("rejects dates that don't exist", () => {
    // #when
    const parse = (): CivilDate => parseIsoDate("2026-02-30");
    // #then
    assert.throws(parse, RangeError);
  });
});
