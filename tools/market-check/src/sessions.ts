import { easternWallClock, sessionClose, type CivilDate } from "@vayle/calendar";

// US equity sessions from the exchange calendar: the regular session, 09:30 ET to the close at
// 16:00 ET or 13:00 ET on an early-close day, and the price feed's own session for the same
// trading day. A us_equities_24/5 feed's session runs from 20:00 ET the evening before to 20:00 ET
// on the day, so back-to-back days join into one stretch from Sunday evening to Friday evening.

const MINUTE = 60;
const DAY = 86_400;
const REGULAR_OPEN_MINUTE_ET = 9 * 60 + 30;
const FEED_SESSION_END_MINUTE_ET = 20 * 60;
// Twenty sessions span about four calendar weeks. Ninety days with too few is a calendar fault.
const MAX_DAYS_BACK = 90;

export const FEED_MARKET_HOURS = "us_equities_24/5";

export interface Window {
  readonly start: number;
  readonly end: number;
}

export interface Session {
  readonly regular: Window;
  readonly feed: Window;
}

export class SessionsUnavailable extends Error {
  override readonly name = "SessionsUnavailable";
}

function utcDate(seconds: number): CivilDate {
  const date = new Date(seconds * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// The trading day's sessions, or null when the exchange doesn't trade. A close falls between
// 17:00 and 21:00 UTC, so the UTC date is the Eastern date. Clocks change at 02:00 on a Sunday,
// never on a trading day, so one Eastern offset holds from the open to the feed session's end,
// and the feed session opens exactly a day before it ends.
export function sessionOn(date: CivilDate): Session | null {
  const close = sessionClose(date);
  if (close === null) return null;
  const closeMinute = easternWallClock(close).minuteOfDay;
  const feedEnd = close + (FEED_SESSION_END_MINUTE_ET - closeMinute) * MINUTE;
  return {
    regular: { start: close - (closeMinute - REGULAR_OPEN_MINUTE_ET) * MINUTE, end: close },
    feed: { start: feedEnd - DAY, end: feedEnd },
  };
}

// The last `count` sessions whose regular close is at or before `at`, oldest first.
export function completedSessions(at: number, count: number): Session[] {
  const found: Session[] = [];
  for (let back = 0; found.length < count; back++) {
    if (back > MAX_DAYS_BACK) {
      throw new SessionsUnavailable(
        `${found.length} of ${count} sessions in the ${MAX_DAYS_BACK} days before ${new Date(at * 1000).toISOString()}`,
      );
    }
    const session = sessionOn(utcDate(at - back * DAY));
    if (session !== null && session.regular.end <= at) found.push(session);
  }
  return found.reverse();
}
