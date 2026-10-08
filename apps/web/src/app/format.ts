import { easternWallClock } from "@vayle/calendar";

// Display formats. Inputs are the chain's integers. Nothing here rounds a value a holder is owed up.

function decimal(units: bigint, decimals: number, places: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").slice(0, places);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${places > 0 ? `.${fraction}` : ""}`;
}

// A price in USDG base units (6 decimals) as dollars and cents, cut, never rounded up.
export function dollars(units: bigint, decimals = 6): string {
  return `$${decimal(units, decimals, 2)}`;
}

// A premium per token can be fractions of a cent, so it keeps four places.
export function premium(units: bigint, decimals = 6): string {
  return `$${decimal(units, decimals, 4)}`;
}

export function usdgAmount(units: bigint, decimals = 6): string {
  return `${decimal(units, decimals, 2)} USDG`;
}

// Raw token units, cut to `places`.
export function tokens(raw: bigint, symbol: string, decimals: number, places = 2): string {
  return `${decimal(raw, decimals, places)} ${symbol}`;
}

// How one market's token amounts print: its ticker, its decimals, and enough places to show one lot
// exactly, never fewer than two. Targets move in whole lots, so every amount on a target prints
// exactly.
export interface TokenUnit {
  readonly symbol: string;
  readonly decimals: number;
  readonly places: number;
}

export function unitOf(market: {
  readonly symbol: string;
  readonly decimals: number;
  readonly lot: bigint;
}): TokenUnit {
  let places = 2;
  while (places < market.decimals && market.lot % 10n ** BigInt(market.decimals - places) !== 0n) {
    places++;
  }
  return { symbol: market.symbol, decimals: market.decimals, places };
}

export function amountOf(raw: bigint, unit: TokenUnit): string {
  return tokens(raw, unit.symbol, unit.decimals, unit.places);
}

// A price step in dollars with every digit it has, so a step of a hundredth of a cent never reads as
// zero: $5.00, $0.0001.
export function step(units: bigint, decimals = 6): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `$${decimal(units, decimals, Math.max(2, fraction.length))}`;
}

// Times are US Eastern, read from the calendar package's wall clock and its DST rules, and labeled
// ET. A time keeps its parts together with no-break spaces, so it never wraps across lines.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const SECONDS_PER_DAY = 86_400;
const MINUTES_PER_DAY = 1_440;
const NBSP = "\u00a0";

// A moment on the US Eastern wall clock.
export interface EasternMoment {
  readonly year: number;
  // 1 to 12.
  readonly month: number;
  readonly day: number;
  // 0 is Sunday through 6, Saturday.
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

export function easternMoment(seconds: number): EasternMoment {
  const whole = Math.floor(seconds);
  const { weekday, minuteOfDay } = easternWallClock(whole);
  const utcMinute = Math.floor(
    (((whole % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) / 60,
  );
  // How far the wall clock runs behind UTC, in minutes: four hours in daylight time, five in
  // standard time. The Eastern date is the UTC date of the moment moved back by that much.
  const behind = (utcMinute - minuteOfDay + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const local = new Date((whole - behind * 60) * 1000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    weekday,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  };
}

function clockOf(m: EasternMoment): string {
  const hour = m.hour % 12 === 0 ? 12 : m.hour % 12;
  const minute = m.minute.toString().padStart(2, "0");
  return `${hour}:${minute}${NBSP}${m.hour < 12 ? "AM" : "PM"}${NBSP}ET`;
}

function dayOf(m: EasternMoment): string {
  return `${WEEKDAYS[m.weekday] ?? ""}, ${MONTHS[m.month - 1] ?? ""} ${m.day}`;
}

// "Fri, Oct 9, 4:00 PM ET".
export function easternTime(seconds: number): string {
  const m = easternMoment(seconds);
  return `${dayOf(m)}, ${clockOf(m)}`;
}

// The time alone, for a moment on a day the sentence already named: "4:00 PM ET".
export function easternClock(seconds: number): string {
  return clockOf(easternMoment(seconds));
}

// The Eastern day, "Fri, Nov 20", with the year when it isn't `thisYear`.
export function easternDay(seconds: number, thisYear?: number): string {
  const m = easternMoment(seconds);
  return thisYear === undefined || m.year === thisYear ? dayOf(m) : `${dayOf(m)}, ${m.year}`;
}

// The Eastern calendar date, "2026-11-20", for grouping and machine-readable dates.
export function easternDate(seconds: number): string {
  const m = easternMoment(seconds);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${m.year}-${pad(m.month)}-${pad(m.day)}`;
}

// The month and day alone, "Oct 9".
export function easternMonthDay(seconds: number): string {
  const m = easternMoment(seconds);
  return `${MONTHS[m.month - 1] ?? ""} ${m.day}`;
}

// The weekday's full name, "Thursday".
export function easternWeekday(seconds: number): string {
  return WEEKDAY_NAMES[easternMoment(seconds).weekday] ?? "";
}

// Feed answers are dollars per token at the feed's own decimals.
export function feedDollars(answer: bigint, decimals: number): string {
  return dollars(answer, decimals);
}
