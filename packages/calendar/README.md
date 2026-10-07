# Calendar

`@vayle/calendar` knows when the US stock market closes. It works out session closes from the exchange's published holidays and early closes and from the federal daylight saving statute, 15 U.S.C. 260a, and turns them into the weekly boundaries the market's `SessionCalendar` contract stores, each with its creation deadline. The deploy schedule comes from its command line. The [maker](../../services/maker/README.md) uses it to tell when the price feed's session is open, the [watcher](../../services/watcher/README.md) to tell whether a quiet feed falls inside the trading week, and the [local fork](../../tools/local-fork/README.md) to schedule the fork's weeks.

A session closes at 16:00 ET, or 13:00 ET on an early-close day, and there's none on weekends or exchange holidays. A weekly boundary is the last close of its Monday-to-Friday week, so a holiday Friday rolls back to Thursday. Its creation deadline is 09:30 ET on the first Monday after it, even when that Monday is a holiday. The published table covers 2026 to 2028, and a date outside it throws `CalendarYearNotCovered` instead of guessing. Daylight saving rules are data keyed by the first year they apply, so a change in the law is one new entry.

## Exports

| Export                                                        | What it does                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sessionClose(date)`                                          | The close on a date in UTC seconds, or null when the exchange doesn't trade                      |
| `weeklyBoundary(date)`, `weeklyBoundariesAfter(after, count)` | The last close of a week, and the next `count` of them after a time                              |
| `creationDeadline(close)`, `boundariesAfter(after, count)`    | A boundary's deadline, and boundaries with deadlines in the shape `SessionCalendar.append` takes |
| `isPlausibleClose`, `isPlausibleCreationDeadline`             | The plausibility rules the contract enforces on a close and on a deadline                        |
| `easternWallClock(seconds)`                                   | The Eastern weekday and minute of day at a UTC time                                              |
| `coveredYears`, `CalendarYearNotCovered`                      | The years the table covers, and the error outside them                                           |

To print the next boundaries after a time, as the JSON the deploy appends:

```sh
pnpm --silent --filter @vayle/calendar boundaries <after-unix-seconds> <count>
```

[DEPLOY.md](../../DEPLOY.md) uses it to write `deployments/calendar-boundaries.json`.

## Tests

```sh
pnpm --filter @vayle/calendar test
```

Property tests with fast-check run across the covered years. They check the published table against holidays generated from the rules, closes against DST changes and early closes, holiday Fridays rolling back, and every boundary's deadline against the contract's rule.
