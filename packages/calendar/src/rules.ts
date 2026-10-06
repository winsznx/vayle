import { addDays, nthWeekday, weekday, type CivilDate } from "./civil.ts";

// Rule-based exchange holidays, used only to cross-check the published table. Saturday holidays
// move to Friday and Sunday holidays to Monday, except New Year's Day on a Saturday, which isn't
// observed.

const MONDAY = 1;
const THURSDAY = 4;

function observed(date: CivilDate): CivilDate | null {
  const day = weekday(date);
  if (day === 6) return addDays(date, -1);
  if (day === 0) return addDays(date, 1);
  return date;
}

// Anonymous Gregorian algorithm for Easter Sunday.
function easter(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

export function ruleBasedHolidays(year: number): CivilDate[] {
  const newYear = { year, month: 1, day: 1 };
  const holidays: (CivilDate | null)[] = [
    weekday(newYear) === 6 ? null : observed(newYear),
    nthWeekday(year, 1, MONDAY, 3),
    nthWeekday(year, 2, MONDAY, 3),
    addDays(easter(year), -2),
    nthWeekday(year, 5, MONDAY, -1),
    observed({ year, month: 6, day: 19 }),
    observed({ year, month: 7, day: 4 }),
    nthWeekday(year, 9, MONDAY, 1),
    nthWeekday(year, 11, THURSDAY, 4),
    observed({ year, month: 12, day: 25 }),
  ];
  return holidays.filter((h): h is CivilDate => h !== null && h.year === year);
}
