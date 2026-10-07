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

// Raw token units. Orders move in 0.01 lots, so two places show every amount exactly.
export function tokens(raw: bigint, symbol: string, decimals = 18): string {
  return `${decimal(raw, decimals, 2)} ${symbol}`;
}

const ET = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

// Joins "4:00 PM EDT" with no-break spaces, so a time never wraps across lines.
function unbroken(time: string): string {
  return time.replace(/(\d)[ \u202f](AM|PM)[ \u202f]/, "$1\u00a0$2\u00a0");
}

export function easternTime(seconds: number): string {
  return unbroken(ET.format(new Date(seconds * 1000)));
}

const ET_CLOCK = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

// The time alone, for a moment on a day the sentence already named.
export function easternClock(seconds: number): string {
  return unbroken(ET_CLOCK.format(new Date(seconds * 1000)));
}

// Feed answers are dollars per token at the feed's own decimals.
export function feedDollars(answer: bigint, decimals: number): string {
  return dollars(answer, decimals);
}
