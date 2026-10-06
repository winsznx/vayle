import {
  addDays,
  daysFromEpoch,
  fromDays,
  isoDate,
  SECONDS_PER_DAY,
  weekday,
  type CivilDate,
} from "./civil.ts";
import { easternOffsetHours } from "./dst.ts";
import { NYSE_EARLY_CLOSES, NYSE_HOLIDAYS } from "./nyse.ts";

export type { CivilDate } from "./civil.ts";
export { DST_SOURCE } from "./dst.ts";
export { NYSE_SOURCE } from "./nyse.ts";

export class CalendarYearNotCovered extends Error {
  override readonly name = "CalendarYearNotCovered";
}

const REGULAR_CLOSE_HOUR_ET = 16;
const EARLY_CLOSE_HOUR_ET = 13;
const SECONDS_PER_HOUR = 3600;

function coveredYear(year: number): { holidays: Set<string>; earlyCloses: Set<string> } {
  const holidays = NYSE_HOLIDAYS[year];
  const earlyCloses = NYSE_EARLY_CLOSES[year];
  if (holidays === undefined || earlyCloses === undefined) {
    throw new CalendarYearNotCovered(`no published exchange calendar for ${year}`);
  }
  return { holidays: new Set(holidays), earlyCloses: new Set(earlyCloses) };
}

export function coveredYears(): number[] {
  return Object.keys(NYSE_HOLIDAYS).map(Number);
}

// The session close on `date` in UTC epoch seconds, or null when the exchange doesn't trade.
export function sessionClose(date: CivilDate): number | null {
  const { holidays, earlyCloses } = coveredYear(date.year);
  const day = weekday(date);
  if (day === 0 || day === 6 || holidays.has(isoDate(date))) return null;
  const hourEt = earlyCloses.has(isoDate(date)) ? EARLY_CLOSE_HOUR_ET : REGULAR_CLOSE_HOUR_ET;
  const hourUtc = hourEt - easternOffsetHours(date);
  return daysFromEpoch(date) * SECONDS_PER_DAY + hourUtc * SECONDS_PER_HOUR;
}

// The last session close in the Monday-to-Friday week containing `date`.
export function weeklyBoundary(date: CivilDate): number | null {
  const monday = addDays(date, -((weekday(date) + 6) % 7));
  for (let offset = 4; offset >= 0; offset--) {
    const close = sessionClose(addDays(monday, offset));
    if (close !== null) return close;
  }
  return null;
}

// The next `count` weekly boundaries strictly after `afterSeconds`.
export function weeklyBoundariesAfter(afterSeconds: number, count: number): number[] {
  const boundaries: number[] = [];
  let cursor = fromDays(Math.floor(afterSeconds / SECONDS_PER_DAY));
  while (boundaries.length < count) {
    const boundary = weeklyBoundary(cursor);
    if (boundary !== null && boundary > afterSeconds && boundaries.at(-1) !== boundary) {
      boundaries.push(boundary);
    }
    cursor = addDays(cursor, 7);
  }
  return boundaries;
}

// The same plausibility rule the SessionCalendar contract enforces.
export function isPlausibleClose(seconds: number): boolean {
  const day = (Math.floor(seconds / SECONDS_PER_DAY) + 4) % 7;
  if (day === 0 || day === 6) return false;
  const secondOfDay = seconds % SECONDS_PER_DAY;
  if (secondOfDay % SECONDS_PER_HOUR !== 0) return false;
  const hour = secondOfDay / SECONDS_PER_HOUR;
  return hour === 17 || hour === 18 || hour === 20 || hour === 21;
}
