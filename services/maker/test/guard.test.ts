import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fc from "fast-check";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { sessionClose, type CivilDate } from "@vayle/calendar";
import {
  ADAPTER_MAX_AGE,
  REOPEN_GRACE,
  priceGuard,
  type FeedRound,
  type PriceReading,
  type PriceVerdict,
} from "../src/guard.ts";
import { feedSessions } from "../src/sessions.ts";

const FEED = {
  feedDecimals: facts.nvdaUsdFeed.decimals,
  feedHeartbeat: facts.nvdaUsdFeed.heartbeatSeconds,
  usdgDecimals: facts.usdg.decimals,
};
const HOUR = 3600;
const DAY = 86_400;
// Round IDs carry the feed's phase in their top bits.
const PHASE_1 = 1n << 64n;

function at(isoWithOffset: string): number {
  return Date.parse(isoWithOffset) / 1000;
}

// Rounds as the NVDA/USD feed published them. 994 was the last before Labor Day, Fri Sep 4 at
// 13:46:24 ET, and 995 the first after it, Mon Sep 7 at 20:00:54 ET.
const ROUND_994: FeedRound = {
  roundId: PHASE_1 | 994n,
  answer: 23_023_665_000n,
  updatedAt: 1_788_543_984,
};
const ROUND_995: FeedRound = {
  roundId: PHASE_1 | 995n,
  answer: 23_108_080_248n,
  updatedAt: 1_788_825_654,
};
// 1162 was the last before the Oct 2 close, Fri at 13:07:32 ET, and 1163 the first after the
// weekend, Sun Oct 4 at 20:00:42 ET.
const ROUND_1162: FeedRound = {
  roundId: PHASE_1 | 1162n,
  answer: 23_499_711_907n,
  updatedAt: 1_790_960_852,
};
const ROUND_1163: FeedRound = {
  roundId: PHASE_1 | 1163n,
  answer: 23_519_217_015n,
  updatedAt: 1_791_158_442,
};
// Wed Oct 7 at 11:01:06 ET.
const ROUND_1188: FeedRound = {
  roundId: PHASE_1 | 1188n,
  answer: 23_719_372_047n,
  updatedAt: 1_791_385_266,
};
// The references the price adapter would set at the Sep 4 and Oct 2 closes, in USDG base units.
const SEP_04_REFERENCE = 230_236_650n;
const OCT_02_REFERENCE = 234_997_119n;
const WEDNESDAY_NOON = at("2026-10-07T12:00:00-04:00");

// A round with round 1188's answer, landed whenever a test needs it.
function roundAt(updatedAt: number): FeedRound {
  return { ...ROUND_1188, roundId: PHASE_1 | 2000n, updatedAt };
}

function reading(round: FeedRound, overrides: Partial<PriceReading> = {}): PriceReading {
  return {
    round: { ok: true, value: round },
    feedDecimals: { ok: true, value: FEED.feedDecimals },
    oraclePaused: { ok: true, value: false },
    reference: OCT_02_REFERENCE,
    ...overrides,
  };
}

function judge(r: PriceReading, now: number): PriceVerdict {
  return priceGuard(r, FEED, feedSessions, now);
}

function reasonOf(verdict: PriceVerdict): string {
  return verdict.usable ? "usable" : verdict.reason;
}

describe("priceGuard on a weekday mid-session", () => {
  it("passes the latest round and prices from its answer", () => {
    // #given: round 1188, an hour old at noon on Wednesday
    const r = reading(ROUND_1188);
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.deepEqual(verdict, {
      usable: true,
      spot: 237.19372047,
      roundId: ROUND_1188.roundId,
      updatedAt: ROUND_1188.updatedAt,
    });
  });

  it("stands down when the oracle flag can't be read", () => {
    // #given
    const r = reading(ROUND_1188, {
      oraclePaused: { ok: false, error: "AbiDecodingDataSizeTooSmallError: no data" },
    });
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "OracleFlagUnreadable");
  });

  it("stands down while the oracle is paused", () => {
    // #given
    const r = reading(ROUND_1188, { oraclePaused: { ok: true, value: true } });
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "OraclePaused");
  });

  it("stands down when the feed's decimals or latest round can't be read", () => {
    // #given
    const failed = { ok: false, error: "HttpRequestError: HTTP request failed" } as const;
    const noDecimals = reading(ROUND_1188, { feedDecimals: failed });
    const noRound = reading(ROUND_1188, { round: failed });
    // #when
    const verdicts = [judge(noDecimals, WEDNESDAY_NOON), judge(noRound, WEDNESDAY_NOON)];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["FeedUnreadable", "FeedUnreadable"]);
  });

  it("stands down when the feed's decimals aren't the ones in the chain facts", () => {
    // #given
    const r = reading(ROUND_1188, { feedDecimals: { ok: true, value: 18 } });
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "FeedDecimalsChanged");
  });

  it("stands down on a round stamped after the block it was read at", () => {
    // #given
    const r = reading(roundAt(WEDNESDAY_NOON + 1));
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "RoundFromTheFuture");
  });

  it("names a timestamp too large for a date instead of failing on it", () => {
    // #given
    const r = reading(roundAt(2 ** 255));
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "RoundFromTheFuture");
  });

  it("stands down on a round more than a day old", () => {
    // #given
    const r = reading(roundAt(WEDNESDAY_NOON - ADAPTER_MAX_AGE - 1));
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "StaleRound");
  });

  it("passes a round exactly a day old, as the price adapter does", () => {
    // #given
    const r = reading(roundAt(WEDNESDAY_NOON - ADAPTER_MAX_AGE));
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("stands down on a zero or negative answer", () => {
    // #given
    const zero = reading({ ...ROUND_1188, answer: 0n });
    const negative = reading({ ...ROUND_1188, answer: -1n });
    // #when
    const verdicts = [judge(zero, WEDNESDAY_NOON), judge(negative, WEDNESDAY_NOON)];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["NonPositiveAnswer", "NonPositiveAnswer"]);
  });

  it("stands down one unit outside half to one and a half times the reference", () => {
    // #given: the band around $234.997119 is $117.4985595 to $352.4956785
    const low = reading({ ...ROUND_1188, answer: 11_749_855_949n });
    const high = reading({ ...ROUND_1188, answer: 35_249_567_851n });
    // #when
    const verdicts = [judge(low, WEDNESDAY_NOON), judge(high, WEDNESDAY_NOON)];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["PriceJump", "PriceJump"]);
  });

  it("passes answers on the band's edges", () => {
    // #given
    const low = reading({ ...ROUND_1188, answer: 11_749_855_950n });
    const high = reading({ ...ROUND_1188, answer: 35_249_567_850n });
    // #when
    const verdicts = [judge(low, WEDNESDAY_NOON), judge(high, WEDNESDAY_NOON)];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["usable", "usable"]);
  });

  it("has no band before the first epoch, when there's nothing to price", () => {
    // #given: an answer a hundred times the last reference
    const r = reading({ ...ROUND_1188, answer: 2_349_971_190_000n }, { reference: null });
    // #when
    const verdict = judge(r, WEDNESDAY_NOON);
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("stands down past the exchange calendar's last published year", () => {
    // #given
    const now = at("2029-01-10T12:00:00-05:00");
    const r = reading(roundAt(now - HOUR));
    // #when
    const verdict = judge(r, now);
    // #then
    assert.equal(reasonOf(verdict), "CalendarNotCovered");
  });
});

describe("priceGuard across the session calendar", () => {
  it("passes Friday's last round after the close, while the feed's session runs on", () => {
    // #given: Fri Oct 2, 17:00 ET, round 1162 from 13:07 ET
    const r = reading(ROUND_1162);
    // #when
    const verdict = judge(r, at("2026-10-02T17:00:00-04:00"));
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("passes Friday's last round after the feed's session ends", () => {
    // #given
    const r = reading(ROUND_1162);
    // #when
    const verdict = judge(r, at("2026-10-02T21:00:00-04:00"));
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("passes Friday's last round all weekend", () => {
    // #given: Sun Oct 4, 19:59 ET, nearly 55 hours after round 1162
    const r = reading(ROUND_1162);
    // #when
    const verdict = judge(r, at("2026-10-04T19:59:00-04:00"));
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("refuses on a weekend a round that was already a day old when Friday's session ended", () => {
    // #given: the feed's last round was Thu Oct 1 at 19:59 ET
    const r = reading(roundAt(at("2026-10-01T19:59:00-04:00")));
    // #when
    const verdict = judge(r, at("2026-10-03T12:00:00-04:00"));
    // #then
    assert.equal(reasonOf(verdict), "StaleRound");
  });

  it("gives the feed a quarter hour to publish once its session reopens", () => {
    // #given: Sun Oct 4, 20:14 ET, still on Friday's round
    const r = reading(ROUND_1162);
    // #when
    const verdict = judge(r, at("2026-10-04T20:00:00-04:00") + REOPEN_GRACE - 60);
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("wants a round from the reopened session after that", () => {
    // #given: Sun Oct 4, 20:16 ET
    const now = at("2026-10-04T20:16:00-04:00");
    // #when
    const verdicts = [judge(reading(ROUND_1162), now), judge(reading(ROUND_1163), now)];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["StaleRound", "usable"]);
  });

  it("passes Thursday's last round through a holiday Friday", () => {
    // #given: Dec 25, 2026, after the Dec 24 early close. The round is 29.5 hours old.
    const r = reading(roundAt(at("2026-12-24T12:30:00-05:00")));
    // #when
    const verdict = judge(r, at("2026-12-25T18:00:00-05:00"));
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });

  it("refuses on a holiday Friday a round that went quiet a day before Thursday's session ended", () => {
    // #given
    const r = reading(roundAt(at("2026-12-23T19:00:00-05:00")));
    // #when
    const verdict = judge(r, at("2026-12-25T18:00:00-05:00"));
    // #then
    assert.equal(reasonOf(verdict), "StaleRound");
  });

  it("passes Friday's round through Labor Day and wants the next session's once it opens", () => {
    // #given: Mon Sep 7, 2026, at noon and at 20:16 ET
    const noon = at("2026-09-07T12:00:00-04:00");
    const evening = at("2026-09-07T20:16:00-04:00");
    const before = reading(ROUND_994, { reference: SEP_04_REFERENCE });
    const after = reading(ROUND_995, { reference: SEP_04_REFERENCE });
    // #when
    const verdicts = [judge(before, noon), judge(before, evening), judge(after, evening)];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["usable", "StaleRound", "usable"]);
  });

  it("reopens at 20:00 EST on the Sunday the clocks go back", () => {
    // #given: Friday's last round, then Sun Nov 1, 2026 just before and after 20:00 EST
    const r = reading(roundAt(at("2026-10-30T15:00:00-04:00")));
    // #when
    const verdicts = [
      judge(r, at("2026-11-01T19:59:00-05:00")),
      judge(r, at("2026-11-01T20:16:00-05:00")),
    ];
    // #then
    assert.deepEqual(verdicts.map(reasonOf), ["usable", "StaleRound"]);
  });

  it("refuses at an early close a round from before the holiday, as the price adapter would", () => {
    // #given: Fri Nov 27, 2026 closes at 13:00 ET after Thanksgiving, and the feed last
    // published Wed Nov 25 at 16:00 ET: 21 hours of session time, 45 hours of wall time
    const r = reading(roundAt(at("2026-11-25T16:00:00-05:00")));
    // #when
    const verdict = judge(r, at("2026-11-27T13:00:00-05:00"));
    // #then
    assert.equal(reasonOf(verdict), "StaleRound");
  });

  it("passes a fresh round when the bid window opens after an early close", () => {
    // #given: Fri Nov 27, 2026 at 15:00 ET, two hours after the close
    const r = reading(roundAt(at("2026-11-27T12:30:00-05:00")));
    // #when
    const verdict = judge(r, at("2026-11-27T15:00:00-05:00"));
    // #then
    assert.equal(reasonOf(verdict), "usable");
  });
});

function civilDay(daysAfterFebruary1st2026: number): CivilDate {
  const date = new Date(Date.UTC(2026, 1, 1 + daysAfterFebruary1st2026));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// Every session close from February 2026 to December 2028, inside the exchange calendar.
const CLOSES = Array.from({ length: 1040 }, (_, i) => sessionClose(civilDay(i))).filter(
  (close): close is number => close !== null,
);

describe("priceGuard properties", () => {
  it("never calls a round under a quarter hour old stale", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: at("2026-02-01T00:00:00Z"), max: at("2028-12-31T00:00:00Z") }),
        fc.integer({ min: 0, max: REOPEN_GRACE }),
        (now, age) => {
          // #given
          const r = reading(roundAt(now - age));
          // #when
          const verdict = judge(r, now);
          // #then
          return verdict.usable;
        },
      ),
    );
  });

  it("refuses a round over a day old from six hours before any close to three hours after", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CLOSES),
        fc.integer({ min: -6 * HOUR, max: 3 * HOUR }),
        fc.oneof(
          fc.integer({ min: ADAPTER_MAX_AGE + 1, max: ADAPTER_MAX_AGE + 6 * HOUR }),
          fc.integer({ min: ADAPTER_MAX_AGE + 6 * HOUR, max: 30 * DAY }),
        ),
        (close, fromClose, age) => {
          // #given
          const now = close + fromClose;
          const r = reading(roundAt(now - age));
          // #when
          const verdict = judge(r, now);
          // #then
          return reasonOf(verdict) === "StaleRound";
        },
      ),
    );
  });
});
