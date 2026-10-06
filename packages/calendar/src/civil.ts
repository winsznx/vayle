// Calendar dates without a time zone, and the integer arithmetic on them.

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const SECONDS_PER_DAY = 86_400;

export function daysFromEpoch(date: CivilDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 1000 / SECONDS_PER_DAY);
}

export function fromDays(days: number): CivilDate {
  const d = new Date(days * SECONDS_PER_DAY * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromDays(daysFromEpoch(date) + days);
}

// 0 is Sunday through 6, Saturday.
export function weekday(date: CivilDate): number {
  return (daysFromEpoch(date) + 4) % 7;
}

export function isoDate(date: CivilDate): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

export function parseIsoDate(text: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) throw new RangeError(`not an ISO date: ${text}`);
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (isoDate(fromDays(daysFromEpoch(date))) !== text)
    throw new RangeError(`no such date: ${text}`);
  return date;
}

// The nth (1-based) given weekday of a month. A negative n counts from the end of the month.
export function nthWeekday(
  year: number,
  month: number,
  targetWeekday: number,
  n: number,
): CivilDate {
  if (n > 0) {
    const first = { year, month, day: 1 };
    const offset = (targetWeekday - weekday(first) + 7) % 7;
    return addDays(first, offset + (n - 1) * 7);
  }
  const last = addDays(
    { year: month === 12 ? year + 1 : year, month: month === 12 ? 1 : month + 1, day: 1 },
    -1,
  );
  const offset = (weekday(last) - targetWeekday + 7) % 7;
  return addDays(last, -(offset + (-n - 1) * 7));
}
