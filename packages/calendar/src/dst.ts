import { nthWeekday, daysFromEpoch, type CivilDate } from "./civil.ts";

// US Eastern time. 15 U.S.C. 260a sets daylight time from 2 a.m. on the second Sunday of March to
// 2 a.m. on the first Sunday of November. Rules are data keyed by the first year they apply, so a
// statute change is a new entry. Session closes fall on weekdays, never on a transition Sunday, so
// the calendar date alone decides the offset.
export const DST_SOURCE =
  "https://www.govinfo.gov/content/pkg/USCODE-2023-title15/html/USCODE-2023-title15-chap6-subchapIX-sec260a.htm";

const STANDARD_OFFSET_HOURS = -5;
const DAYLIGHT_OFFSET_HOURS = -4;

interface DstRule {
  readonly fromYear: number;
  readonly daylight: (date: CivilDate) => boolean;
}

const SUNDAY = 0;

const DST_RULES: readonly DstRule[] = [
  {
    fromYear: 2007,
    daylight: (date) => {
      const start = daysFromEpoch(nthWeekday(date.year, 3, SUNDAY, 2));
      const end = daysFromEpoch(nthWeekday(date.year, 11, SUNDAY, 1));
      const today = daysFromEpoch(date);
      return today >= start && today < end;
    },
  },
];

export class DstRuleMissing extends Error {
  override readonly name = "DstRuleMissing";
}

export function easternOffsetHours(date: CivilDate): number {
  const rule = [...DST_RULES].reverse().find((r) => date.year >= r.fromYear);
  if (rule === undefined) throw new DstRuleMissing(`no DST rule covers ${date.year}`);
  return rule.daylight(date) ? DAYLIGHT_OFFSET_HOURS : STANDARD_OFFSET_HOURS;
}
