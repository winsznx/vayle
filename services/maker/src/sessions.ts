import {
  CalendarYearNotCovered,
  easternWallClock,
  sessionClose,
  type CivilDate,
} from "@vayle/calendar";
import { CalendarNotCovered } from "./errors.ts";

// When the NVDA/USD feed publishes. Its 24/5 session for each trading day runs from 20:00 ET the
// evening before to 20:00 ET on the day, so it's quiet over weekends and exchange holidays. Trading
// days, early closes and DST come from the exchange calendar.

const MINUTE = 60;
const DAY = 86_400;
// The feed's session ends at 20:00 ET, after the exchange's late trading.
const SESSION_END_MINUTE_ET = 20 * 60;
// The run in progress, the quiet days before it and the run before that span about two weeks, so
// a month with no session means the calendar has nothing to give.
const MAX_DAYS_BACK = 31;

// Back-to-back sessions, in epoch seconds.
export interface SessionRun {
  readonly opens: number;
  readonly closes: number;
}

export interface SessionsAround {
  // When the run in progress opened, or null while the feed's session is closed.
  readonly openSince: number | null;
  // The last run that had closed by then.
  readonly lastClosed: SessionRun;
}

export type FeedSessions = (at: number) => SessionsAround;

function utcDate(seconds: number): CivilDate {
  const date = new Date(seconds * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// The feed's session for a trading day, or null when the exchange doesn't trade. It opens exactly a
// day before it closes, because clocks change at 02:00 on a Sunday and Sunday never trades.
function sessionOn(date: CivilDate): SessionRun | null {
  let close: number | null;
  try {
    close = sessionClose(date);
  } catch (error) {
    if (error instanceof CalendarYearNotCovered) {
      throw new CalendarNotCovered(error.message, { cause: error });
    }
    throw error;
  }
  if (close === null) return null;
  const closes = close + (SESSION_END_MINUTE_ET - easternWallClock(close).minuteOfDay) * MINUTE;
  return { opens: closes - DAY, closes };
}

// Walks back from `at` a day at a time, joining back-to-back sessions into runs, until it has the
// run in progress, if any, and the last run that closed.
export const feedSessions: FeedSessions = (at) => {
  let openSince: number | null = null;
  let run: SessionRun | null = null;
  for (let back = 0; back <= MAX_DAYS_BACK; back++) {
    const session = sessionOn(utcDate(at - back * DAY));
    // The session for the UTC date of `at` may not have opened yet.
    if (session !== null && session.opens > at) continue;
    if (session !== null && run !== null && session.closes === run.opens) {
      run = { opens: session.opens, closes: run.closes };
      continue;
    }
    if (run !== null) {
      if (run.closes <= at) return { openSince, lastClosed: run };
      openSince = run.opens;
    }
    run = session;
  }
  throw new CalendarNotCovered(
    `no feed session in the ${MAX_DAYS_BACK} days before ${new Date(at * 1000).toISOString()}`,
  );
};
