import { formatUnits } from "viem";
import type { MakerConfig } from "./config.ts";
import { CalendarNotCovered } from "./errors.ts";
import type { FeedSessions, SessionsAround } from "./sessions.ts";

// Whether the feed's latest round is fit to price a bid or a quote on. The market reads no price
// when it takes either, so nothing else stands between a bad round and a premium.

const MINUTE = 60;
const HOUR = 3600;
// The price adapter refuses a reference round more than a day older than its close.
export const ADAPTER_MAX_AGE = 24 * HOUR;
// A live feed publishes as soon as its session reopens. A quarter hour allows for a slow round.
export const REOPEN_GRACE = 15 * MINUTE;
// The price adapter refuses a reference under half or over one and a half times the last one, and
// the maker holds the round it prices on to the same band around this week's reference.
const JUMP_FLOOR = 1n;
const JUMP_CEILING = 3n;
const JUMP_DENOMINATOR = 2n;

export interface FeedRound {
  readonly roundId: bigint;
  readonly answer: bigint;
  // When the round landed, in block time.
  readonly updatedAt: number;
}

// A price input as the snapshot read it: the value, or what stopped the read.
export type Reading<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface PriceReading {
  readonly round: Reading<FeedRound>;
  readonly feedDecimals: Reading<number>;
  readonly oraclePaused: Reading<boolean>;
  // This week's reference price in USDG base units per raw token, or null before the first epoch.
  readonly reference: bigint | null;
}

export type StandDownReason =
  | "OracleFlagUnreadable"
  | "OraclePaused"
  | "FeedUnreadable"
  | "FeedDecimalsChanged"
  | "RoundFromTheFuture"
  | "CalendarNotCovered"
  | "StaleRound"
  | "NonPositiveAnswer"
  | "PriceJump";

export interface UsablePrice {
  readonly usable: true;
  // The round's answer in USDG per whole raw token.
  readonly spot: number;
  readonly roundId: bigint;
}

export interface StandDown {
  readonly usable: false;
  readonly reason: StandDownReason;
  readonly detail: string;
}

export type PriceVerdict = UsablePrice | StandDown;

type FeedFacts = Pick<MakerConfig, "feedDecimals" | "feedHeartbeat" | "usdgDecimals">;

function standDown(reason: StandDownReason, detail: string): StandDown {
  return { usable: false, reason, detail };
}

function iso(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? `${seconds} s` : date.toISOString().replace(".000Z", "Z");
}

// The oldest round a live feed could still be showing. While a run of sessions is open that's a
// heartbeat back, and once the run is past its reopen grace the round has to come from the run.
// While the feed is quiet, the round has to have been that fresh when the last run closed.
function oldestLiveRound(around: SessionsAround, now: number, maxAge: number): number {
  const { openSince, lastClosed } = around;
  if (openSince !== null && now >= openSince + REOPEN_GRACE) {
    return Math.max(openSince, now - maxAge);
  }
  return Math.max(lastClosed.opens, lastClosed.closes - maxAge);
}

// The price adapter's jump test on exact integers. The answer in feed decimals and the reference in
// USDG decimals are brought to one unit, and the answer is doubled so the band's halves stay whole.
function outsideBand(answer: bigint, reference: bigint, feed: FeedFacts): boolean {
  const doubled = answer * JUMP_DENOMINATOR * 10n ** BigInt(feed.usdgDecimals);
  const scaled = reference * 10n ** BigInt(feed.feedDecimals);
  return doubled < scaled * JUMP_FLOOR || doubled > scaled * JUMP_CEILING;
}

// Checks run in the price adapter's order, and the first that fails names the reason. `now` is the
// time of the block every input was read at, which is the clock the feed stamps rounds with.
export function priceGuard(
  reading: PriceReading,
  feed: FeedFacts,
  sessions: FeedSessions,
  now: number,
): PriceVerdict {
  const { round, feedDecimals, oraclePaused, reference } = reading;
  if (!oraclePaused.ok) {
    return standDown("OracleFlagUnreadable", `oraclePaused() failed: ${oraclePaused.error}`);
  }
  if (oraclePaused.value) return standDown("OraclePaused", "the token's oracle is paused");
  if (!feedDecimals.ok) {
    return standDown("FeedUnreadable", `decimals() failed: ${feedDecimals.error}`);
  }
  if (feedDecimals.value !== feed.feedDecimals) {
    return standDown(
      "FeedDecimalsChanged",
      `the feed reports ${feedDecimals.value} decimals, the chain facts ${feed.feedDecimals}`,
    );
  }
  if (!round.ok) return standDown("FeedUnreadable", `latestRoundData() failed: ${round.error}`);

  const { roundId, answer, updatedAt } = round.value;
  const name = `round ${roundId.toString()}`;
  if (updatedAt > now) {
    return standDown(
      "RoundFromTheFuture",
      `${name} is stamped ${iso(updatedAt)}, after the block it was read at, ${iso(now)}`,
    );
  }
  let around: SessionsAround;
  try {
    around = sessions(now);
  } catch (error) {
    if (error instanceof CalendarNotCovered) return standDown("CalendarNotCovered", error.message);
    throw error;
  }
  // A live feed publishes at least once a heartbeat, and the adapter allows a day at most.
  const oldest = oldestLiveRound(around, now, Math.min(feed.feedHeartbeat, ADAPTER_MAX_AGE));
  if (updatedAt < oldest) {
    return standDown(
      "StaleRound",
      `${name} landed ${iso(updatedAt)}, and a live feed would have published since ${iso(oldest)}`,
    );
  }
  if (answer <= 0n) return standDown("NonPositiveAnswer", `${name} answered ${answer.toString()}`);
  // Before the first epoch there's no reference, and nothing to bid on or quote either.
  if (reference !== null && outsideBand(answer, reference, feed)) {
    return standDown(
      "PriceJump",
      `${name} answered ${formatUnits(answer, feed.feedDecimals)}, outside half to one and a half times this week's reference of ${formatUnits(reference, feed.usdgDecimals)}`,
    );
  }
  return { usable: true, spot: Number(answer) / 10 ** feedDecimals.value, roundId };
}

// The latest answer in USDG per whole raw token when it's positive, whatever the guard makes of it.
// Exercise judges which longs are in the money on it.
export function latestAnswer({ round, feedDecimals }: PriceReading): number | null {
  if (!round.ok || !feedDecimals.ok || round.value.answer <= 0n) return null;
  return Number(round.value.answer) / 10 ** feedDecimals.value;
}
