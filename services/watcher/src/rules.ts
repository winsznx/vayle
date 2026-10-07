import { easternWallClock } from "@vayle/calendar";
import type { ChainEvent } from "./events.ts";
import type { MarketSnapshot, Snapshot } from "./snapshot.ts";

export type Severity = "page" | "warn" | "info";

export interface Alert {
  readonly key: string;
  readonly severity: Severity;
  readonly text: string;
}

export interface ActiveCondition {
  readonly severity: Severity;
  readonly since: number;
  readonly lastSent: number;
}

export type ActiveConditions = Readonly<Record<string, ActiveCondition>>;

const MINUTE = 60;
const HOUR = 3600;
// The keeper starts 45 minutes before each close, and a close's window runs 2 hours after it.
export const KEEPER_LEAD = 45 * MINUTE;
export const KEEPER_TAIL = 2 * HOUR + 30 * MINUTE;
export const KEEPER_SILENCE = 3 * MINUTE;
export const EPOCH_GRACE = 15 * MINUTE;
export const EPOCH_PAGE_LEAD = 6 * HOUR;
export const MIN_BOUNDARIES_AHEAD = 5;
// The feed's published heartbeat is 24 hours, inside the 24/5 trading week.
export const FEED_MAX_AGE = 25 * HOUR;
export const REPAGE_INTERVAL = HOUR;

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, page: 2 };

export function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

// The trading week runs from Sunday 20:00 ET to Friday 20:00 ET. The first hour after the open is
// excluded, so a feed that resumes a little late doesn't count as stale.
export function inTradingWeek(seconds: number): boolean {
  const { weekday, minuteOfDay } = easternWallClock(seconds);
  if (weekday === 6) return false;
  if (weekday === 5) return minuteOfDay < 20 * 60;
  if (weekday === 0) return minuteOfDay >= 21 * 60;
  return true;
}

export function conditions(s: Snapshot): Alert[] {
  const found: Alert[] = [];
  const { issuer } = s;
  if (issuer.nvdaPaused) {
    found.push({
      key: "issuer-paused:nvda",
      severity: "page",
      text: "NVDA is paused by its issuer. Exercises and withdrawals in NVDA fail until it resumes.",
    });
  }
  if (issuer.accessRegistryPaused) {
    found.push({
      key: "issuer-paused:access-registry",
      severity: "page",
      text: "The Stock Tokens' access registry is paused. NVDA transfers fail until it resumes.",
    });
  }
  if (issuer.usdgPaused) {
    found.push({
      key: "issuer-paused:usdg",
      severity: "page",
      text: "USDG is paused by its issuer. Premiums, strikes and withdrawals in USDG fail until it resumes.",
    });
  }
  if (issuer.oraclePaused) {
    found.push({
      key: "oracle-paused:nvda",
      severity: "page",
      text: "NVDA's oracle is paused. New fills and epoch creation are refused until it resumes.",
    });
  }
  if (issuer.newUIMultiplier !== issuer.uiMultiplier && issuer.effectiveAt > s.now) {
    found.push({
      key: "multiplier-pending:nvda",
      severity: "warn",
      text: `NVDA's multiplier changes from ${issuer.uiMultiplier.toString()} to ${issuer.newUIMultiplier.toString()} at ${iso(issuer.effectiveAt)}.`,
    });
  }
  if (s.now - s.feedUpdatedAt > FEED_MAX_AGE && inTradingWeek(s.now)) {
    found.push({
      key: "feed-stale:nvda",
      severity: "warn",
      text: `The NVDA feed hasn't updated since ${iso(s.feedUpdatedAt)} in the trading week.`,
    });
  }
  if (s.market !== null) found.push(...marketConditions(s.now, s.market));
  return found;
}

function marketConditions(now: number, m: MarketSnapshot): Alert[] {
  const found: Alert[] = [];
  if (m.haltedUntil > now) {
    found.push({
      key: "halt-active",
      severity: "page",
      text: `The market is halted until ${iso(m.haltedUntil)}.`,
    });
  }
  if (m.paused || m.assetPaused) {
    found.push({
      key: "market-paused",
      severity: "warn",
      text: m.paused ? "New positions are paused market-wide." : "New NVDA positions are paused.",
    });
  }
  const afterClose = m.latestBoundary !== null && now <= m.latestBoundary.close + KEEPER_TAIL;
  const beforeClose = m.nextClose !== null && now >= m.nextClose - KEEPER_LEAD;
  if ((afterClose || beforeClose) && now - m.lastSeen > KEEPER_SILENCE) {
    found.push({
      key: "keeper-silent",
      severity: "page",
      text: `No liveness checkpoint since ${iso(m.lastSeen)}, inside a close or exercise window.`,
    });
  }
  const opening = m.latestBoundary;
  if (
    opening !== null &&
    !m.epochOpenedAtLatest &&
    now > opening.close + EPOCH_GRACE &&
    now < opening.creationDeadline
  ) {
    found.push({
      key: "epoch-missing:nvda",
      severity: now >= opening.creationDeadline - EPOCH_PAGE_LEAD ? "page" : "warn",
      text: `No NVDA epoch opened at the ${iso(opening.close)} close. Creation closes at ${iso(opening.creationDeadline)}.`,
    });
  }
  if (m.boundariesAhead < MIN_BOUNDARIES_AHEAD) {
    found.push({
      key: "calendar-runway",
      severity: "warn",
      text: `Only ${m.boundariesAhead} future boundaries are scheduled. Adding more takes the timelock over a week.`,
    });
  }
  return found;
}

// New conditions alert once. A condition that escalates alerts again, a page repeats every hour,
// and a condition that clears sends one notice.
export function transitions(
  previous: ActiveConditions,
  current: readonly Alert[],
  now: number,
): { alerts: Alert[]; active: Record<string, ActiveCondition> } {
  const alerts: Alert[] = [];
  const active: Record<string, ActiveCondition> = {};
  for (const condition of current) {
    const before = previous[condition.key];
    if (before === undefined || RANK[condition.severity] > RANK[before.severity]) {
      alerts.push(condition);
      active[condition.key] = {
        severity: condition.severity,
        since: before?.since ?? now,
        lastSent: now,
      };
    } else if (condition.severity === "page" && now - before.lastSent >= REPAGE_INTERVAL) {
      alerts.push({
        ...condition,
        text: `Still active since ${iso(before.since)}. ${condition.text}`,
      });
      active[condition.key] = { ...before, lastSent: now };
    } else {
      active[condition.key] = { ...before, severity: condition.severity };
    }
  }
  for (const [key, before] of Object.entries(previous)) {
    if (key in active) continue;
    alerts.push({
      key,
      severity: "info",
      text: `Cleared: ${key}, active since ${iso(before.since)}.`,
    });
  }
  return { alerts, active };
}

const EVENT_SEVERITY: Readonly<Record<string, Severity>> = {
  HaltStarted: "page",
  HaltExtended: "page",
  HaltEnded: "page",
  OraclePauseObserved: "page",
  PauseObserved: "page",
  PauseEnded: "info",
  GapRecorded: "warn",
  PausedSet: "warn",
  AssetPausedSet: "warn",
  GuardianSet: "warn",
  CapsSet: "warn",
  FeeSet: "warn",
  TeamOperatedSet: "warn",
  OwnershipTransferStarted: "warn",
  OwnershipTransferred: "warn",
  BoundariesAppended: "info",
  BoundariesTruncated: "info",
  AssetListed: "info",
  AssetDelisted: "info",
  EpochCreated: "info",
  BatchDone: "info",
  QuoteFilled: "info",
};

function formatArgs(args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(args, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

// One alert per log the owner should see. Fills by the team's own maker are routine and skipped.
export function eventAlerts(events: readonly ChainEvent[], explorer: string): Alert[] {
  const alerts: Alert[] = [];
  for (const event of events) {
    const severity = EVENT_SEVERITY[event.name];
    if (severity === undefined) continue;
    if (event.name === "QuoteFilled" && event.args["teamOperated"] === true) continue;
    alerts.push({
      key: `event:${event.transactionHash}:${event.logIndex}`,
      severity,
      text: `${event.name} ${formatArgs(event.args)} ${explorer}/tx/${event.transactionHash}`,
    });
  }
  return alerts;
}
