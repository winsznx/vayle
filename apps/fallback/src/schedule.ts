import { livenessCheckpointAbi, sessionCalendarAbi, vayleMarketAbi } from "@vayle/abi";
import type { Address, PublicClient } from "viem";
import { refusalOf } from "./refusals.ts";
import { duration, moment } from "./view.ts";

// When a checkpoint or a close observation keeps the week on schedule. The market's own numbers
// are read from the deployment. The keeper's two margins around them aren't on chain, so they live
// here, written relative to the market's numbers so they follow the contract if it changes.

// The keeper's first checkpoint before a close goes out this long before the lookback starts, so
// one that lands late still lands in time. With the market's lookback that's the keeper's lead.
export const FIRST_CHECKPOINT_MARGIN = 15n * 60n;
// The keeper keeps checkpointing this long past a window's usual end, in case quiet time or a
// pause is holding it open.
export const WINDOW_MARGIN = 30n * 60n;

// The close the next observation is for: the first one at or after now, as observeClose finds it.
export interface CloseAhead {
  readonly close: bigint;
  // The window that opens at this close, from the week that ends there. Null when no week does.
  readonly windowLength: bigint | null;
  // Seconds of gaps already recorded in the lookback before this close.
  readonly gapSeconds: bigint;
  // The latest observation of this close that found the price feed running, or 0 for none.
  readonly lastClear: bigint;
  readonly pausedSeen: boolean;
}

// The last close at or before now, with the window of the week that ended there, if one did.
export interface CloseBehind {
  readonly close: bigint;
  readonly windowLength: bigint | null;
}

export interface Schedule {
  readonly now: bigint;
  readonly liveness: Address;
  readonly lastSeen: bigint;
  readonly gapThreshold: bigint;
  readonly lookback: bigint;
  readonly recency: bigint;
  readonly extensionCap: bigint;
  readonly ahead: CloseAhead | null;
  readonly behind: CloseBehind | null;
}

// A read the market refuses with `refusal` comes back as null. Every other failure is thrown.
async function unless<T>(read: Promise<T>, refusal: string): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (refusalOf(error)?.name === refusal) return null;
    throw error;
  }
}

export async function readSchedule(
  client: PublicClient,
  market: Address,
  asset: Address,
  now: bigint,
): Promise<Schedule> {
  const vayle = { address: market, abi: vayleMarketAbi } as const;
  const [liveness, calendar, lookback, recency, extensionCap] = await Promise.all([
    client.readContract({ ...vayle, functionName: "liveness" }),
    client.readContract({ ...vayle, functionName: "calendar" }),
    client.readContract({ ...vayle, functionName: "LIVENESS_LOOKBACK" }),
    client.readContract({ ...vayle, functionName: "CLOSE_OBSERVATION_RECENCY" }),
    client.readContract({ ...vayle, functionName: "LIVENESS_EXTENSION_CAP" }),
  ]);
  const checkpoints = { address: liveness, abi: livenessCheckpointAbi } as const;
  const closes = { address: calendar, abi: sessionCalendarAbi } as const;
  const [lastSeen, gapThreshold, aheadClose, behindBoundary] = await Promise.all([
    client.readContract({ ...checkpoints, functionName: "lastSeen" }),
    client.readContract({ ...checkpoints, functionName: "GAP_THRESHOLD" }),
    unless(
      client.readContract({ ...closes, functionName: "nextCloseAfter", args: [now - 1n] }),
      "NoCloseAfter",
    ),
    unless(
      client.readContract({ ...closes, functionName: "latestBoundaryAtOrBefore", args: [now] }),
      "NoCloseAtOrBefore",
    ),
  ]);

  // An epoch is keyed by its expiry, so one at a close means a week ends there.
  const windowEndingAt = async (close: bigint): Promise<bigint | null> => {
    const week = await unless(
      client.readContract({ ...vayle, functionName: "epoch", args: [asset, close] }),
      "UnknownEpoch",
    );
    return week === null ? null : BigInt(week.windowLength);
  };
  const readAhead = async (close: bigint): Promise<CloseAhead> => {
    const [windowLength, observation, gapSeconds] = await Promise.all([
      windowEndingAt(close),
      client.readContract({ ...vayle, functionName: "closeObservation", args: [asset, close] }),
      client.readContract({
        ...checkpoints,
        functionName: "gapOverlap",
        args: [close - lookback, close],
      }),
    ]);
    const { lastClear, pausedSeen } = observation;
    return { close, windowLength, gapSeconds, lastClear, pausedSeen };
  };
  const readBehind = async (close: bigint): Promise<CloseBehind> => ({
    close,
    windowLength: await windowEndingAt(close),
  });
  const [ahead, behind] = await Promise.all([
    aheadClose === null ? null : readAhead(aheadClose),
    behindBoundary === null ? null : readBehind(behindBoundary.close),
  ]);
  return { now, liveness, lastSeen, gapThreshold, lookback, recency, extensionCap, ahead, behind };
}

// A window one of the account's own series sits in, as the market reports it.
export interface KnownWindow {
  // The close it opened at, which is the series' expiry.
  readonly opened: bigint;
  // The end the market reports, or the later end finalizing it would find.
  readonly end: bigint;
  // Finalized, or finalizing it would go through.
  readonly closed: boolean;
}

export interface Advice {
  readonly why: string;
  readonly lastCheckpoint: string;
  readonly ahead: string;
  // What to send around the close ahead, in order. Empty when there's no close ahead.
  readonly around: readonly string[];
  readonly checkpoint: readonly string[];
  readonly observe: { readonly open: boolean; readonly refused: boolean; readonly text: string };
}

// Where now falls before the close ahead. Inside the lookback observeClose works, the keeper's lead
// comes just before that, and anything earlier is early.
type Stretch = "observe" | "lead" | "early";

interface OpenWindow {
  readonly opened: bigint;
  // The end it has at least: its usual end, or later when one of the account's series says so.
  readonly end: bigint;
  // When checkpoints stop mattering for it.
  readonly until: bigint;
}

// The window of the week that ended at the last close, while checkpoints still matter for it: as
// the keeper does, through the usual end plus its margin, or for as long as one of the account's
// series reports it open.
function openWindow(s: Schedule, known: readonly KnownWindow[]): OpenWindow | null {
  const behind = s.behind;
  if (behind === null || behind.windowLength === null) return null;
  const week = known.filter((w) => w.opened === behind.close);
  // Every series of a week shares one window, so one that's over means they all are.
  if (week.some((w) => w.closed)) return null;
  const usualEnd = behind.close + behind.windowLength;
  const keeperEnd = usualEnd + WINDOW_MARGIN;
  const end = week.reduce((latest, w) => (w.end > latest ? w.end : latest), usualEnd);
  if (s.now > keeperEnd && s.now >= end) return null;
  return { opened: behind.close, end, until: end > keeperEnd ? end : keeperEnd };
}

// Why the week that opens at the close ahead is already refused, or null while it can still open.
// Only meaningful inside the lookback, where all three can happen.
function refusedBecause(s: Schedule, a: CloseAhead, quiet: boolean, symbol: string): string | null {
  if (a.pausedSeen) {
    return `an observation found ${symbol}'s price feed paused in the ${duration(s.lookback)} before it.`;
  }
  if (a.gapSeconds > 0n) {
    return `the chain went more than ${duration(s.gapThreshold)} without a checkpoint in the ${duration(s.lookback)} before it.`;
  }
  // Whoever checkpoints next records the quiet time as one gap, and it ends inside the lookback.
  if (quiet && s.now > a.close - s.lookback) {
    return `nobody has checkpointed since ${moment(s.lastSeen)}, and that gap reaches into the ${duration(s.lookback)} before it.`;
  }
  return null;
}

function windowLine(s: Schedule, w: OpenWindow): string {
  const week = `The week that ended at ${moment(w.opened)}`;
  const keepGoing = `checkpoint at least every ${duration(s.gapThreshold)} until ${moment(w.until)}`;
  return s.now < w.end
    ? `${week} is in its exercise window until at least ${moment(w.end)}. Quiet time holds it open, up to ${duration(s.extensionCap)} in total, so ${keepGoing}.`
    : `${week} had its exercise window until at least ${moment(w.end)}. In case quiet time is holding it open, ${keepGoing}.`;
}

function stretchOf(toClose: bigint, lookback: bigint, lead: bigint): Stretch {
  if (toClose <= lookback) return "observe";
  return toClose <= lead ? "lead" : "early";
}

function observedLine(a: CloseAhead, recency: bigint): string {
  if (a.lastClear === 0n) return "Nobody has observed this close yet.";
  return a.lastClear >= a.close - recency
    ? `One did at ${moment(a.lastClear)}.`
    : `The last one that did was at ${moment(a.lastClear)}.`;
}

export function scheduleAdvice(s: Schedule, known: readonly KnownWindow[], symbol: string): Advice {
  const lead = s.lookback + FIRST_CHECKPOINT_MARGIN;
  // The contract records a gap when two checkpoints are more than the threshold apart.
  const quiet = s.now - s.lastSeen > s.gapThreshold;
  const window = openWindow(s, known);
  const a = s.ahead;
  const stretch = a === null ? null : stretchOf(a.close - s.now, s.lookback, lead);
  const refused = a !== null && stretch === "observe" ? refusedBecause(s, a, quiet, symbol) : null;
  const windowAhead = a !== null && a.windowLength !== null;
  const matters =
    window !== null ||
    stretch === "lead" ||
    (stretch === "observe" && (refused === null || windowAhead));

  const why = `A week opens at a close only if the chain was checkpointed, with no gap longer than ${duration(s.gapThreshold)}, through the ${duration(s.lookback)} before it, and an observation in its last ${duration(s.recency)} found ${symbol}'s price feed running. Vayle's keeper makes these calls and keeps checkpointing through each exercise window, and when it's down anyone can make them here.`;

  const landed = `The last checkpoint landed at ${moment(s.lastSeen)}.`;
  const lastCheckpoint = !matters
    ? landed
    : quiet
      ? `${landed} That's more than ${duration(s.gapThreshold)} ago, so the next one records the quiet time as a gap.`
      : `${landed} The next one has to land by ${moment(s.lastSeen + s.gapThreshold)}, or the quiet time is recorded as a gap.`;

  const ahead =
    a === null
      ? `The market's calendar has no close after ${moment(s.now)}.`
      : `The next close is ${moment(a.close)}.`;
  const around =
    a === null
      ? []
      : [
          `From ${duration(lead)} before it until ${duration(s.lookback)} before, checkpoint at least every ${duration(s.gapThreshold)}. After a quiet stretch, the first one has to land by ${moment(a.close - s.lookback)}.`,
          `In the last ${duration(s.lookback)}, observe the close at least every ${duration(s.gapThreshold)}, with one in the last ${duration(s.recency)}. Each observation is a checkpoint too.`,
          a.windowLength === null
            ? "No week ends at this close, so no exercise window opens after it."
            : `For ${duration(a.windowLength + WINDOW_MARGIN)} after it, checkpoint at least every ${duration(s.gapThreshold)}. That covers the exercise window of the week that ends then, which runs at least ${duration(a.windowLength)}, longer while the chain is quiet.`,
        ];

  const checkpoint: string[] = window === null ? [] : [windowLine(s, window)];
  if (a !== null && stretch === "observe") {
    if (refused === null) {
      checkpoint.push(
        "Observing the close is a checkpoint too, so that's the one to send until the close.",
      );
    } else if (windowAhead) {
      checkpoint.push(
        "Checkpoints still keep quiet time out of the exercise window that opens at the close.",
      );
    }
  } else if (a !== null && stretch === "lead") {
    const late = quiet
      ? ` The quiet time before it is recorded as a gap, which does no harm as long as it lands by ${moment(a.close - s.lookback)}.`
      : "";
    checkpoint.push(
      `Checkpoint now, and at least every ${duration(s.gapThreshold)} until the close.${late}`,
    );
  }
  if (checkpoint.length === 0) {
    const next =
      a !== null && stretch === "early" ? ` They matter again from ${moment(a.close - lead)}.` : "";
    checkpoint.push(
      `Nothing needs a checkpoint right now, though anyone can send one at any time.${next}`,
    );
  }

  let observe: Advice["observe"];
  if (a === null) {
    observe = { open: false, refused: false, text: "There's no close ahead to observe." };
  } else if (stretch !== "observe") {
    observe = {
      open: false,
      refused: false,
      text: `The market takes this from ${moment(a.close - s.lookback)} until the close. Read again then to send it.`,
    };
  } else if (refused !== null) {
    observe = {
      open: false,
      refused: true,
      text: `The week that starts at this close can't open, because ${refused}`,
    };
  } else {
    observe = {
      open: true,
      refused: false,
      text: `Observe it now, and at least every ${duration(s.gapThreshold)} until the close. The week needs one that finds ${symbol}'s price feed running in the last ${duration(s.recency)}, from ${moment(a.close - s.recency)} on. ${observedLine(a, s.recency)}`,
    };
  }

  return { why, lastCheckpoint, ahead, around, checkpoint, observe };
}
