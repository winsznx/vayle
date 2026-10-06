// Holidays and early closes as published by the exchange. This table is the source of truth. The
// rules in rules.ts exist only to cross-check it. Years outside the table fail closed.
export const NYSE_SOURCE = {
  url: "https://www.nyse.com/markets/hours-calendars",
  retrievedOn: "2026-10-06",
} as const;

export const NYSE_HOLIDAYS: Readonly<Record<number, readonly string[]>> = {
  2026: [
    "2026-01-01",
    "2026-01-19",
    "2026-02-16",
    "2026-04-03",
    "2026-05-25",
    "2026-06-19",
    "2026-07-03",
    "2026-09-07",
    "2026-11-26",
    "2026-12-25",
  ],
  2027: [
    "2027-01-01",
    "2027-01-18",
    "2027-02-15",
    "2027-03-26",
    "2027-05-31",
    "2027-06-18",
    "2027-07-05",
    "2027-09-06",
    "2027-11-25",
    "2027-12-24",
  ],
  // New Year's Day 2028 falls on a Saturday and isn't observed.
  2028: [
    "2028-01-17",
    "2028-02-21",
    "2028-04-14",
    "2028-05-29",
    "2028-06-19",
    "2028-07-04",
    "2028-09-04",
    "2028-11-23",
    "2028-12-25",
  ],
};

// Sessions that close at 13:00 ET instead of 16:00 ET.
export const NYSE_EARLY_CLOSES: Readonly<Record<number, readonly string[]>> = {
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
  2028: ["2028-07-03", "2028-11-24"],
};
