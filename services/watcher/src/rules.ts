import { easternWallClock } from "@vayle/calendar";
import type { Market } from "@vayle/markets";
import type { ChainEvent } from "./events.ts";
import type {
  Caps,
  ListedState,
  MarketSnapshot,
  MarketWatch,
  Snapshot,
  TokenState,
} from "./snapshot.ts";

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
// A market's first week can open once the liveness record covers a lookback after the deploy. An
// hour after that, a first week that still hasn't opened needs a person.
export const FIRST_EPOCH_GRACE = HOUR;
export const MIN_BOUNDARIES_AHEAD = 5;
// A feed publishes at least once a heartbeat inside the 24/5 trading week. A round older than that
// by this much is stale.
export const FEED_GRACE = HOUR;
export const REPAGE_INTERVAL = HOUR;

const RANK: Readonly<Record<Severity, number>> = { info: 0, warn: 1, page: 2 };
const CAP_FIELDS = ["openSize", "walletSize", "seriesOpenInterest", "fillSize"] as const;

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

// An access registry is shared by the tokens that name it, so each paused one alerts once, naming
// them all.
function registryConditions(markets: readonly MarketWatch[]): Alert[] {
  const paused = new Map<string, string[]>();
  for (const { market, token } of markets) {
    if (token === null || !token.accessRegistryPaused) continue;
    paused.set(token.accessRegistry, [...(paused.get(token.accessRegistry) ?? []), market.symbol]);
  }
  return [...paused].map(([registry, symbols]) => ({
    key: `issuer-paused:access-registry:${registry.toLowerCase()}`,
    severity: "page",
    text: `The access registry ${registry} is paused. ${symbols.join(", ")} transfers fail until it resumes.`,
  }));
}

export function conditions(s: Snapshot): Alert[] {
  const found: Alert[] = [];
  if (s.usdgPaused) {
    found.push({
      key: "issuer-paused:usdg",
      severity: "page",
      text: "USDG is paused by its issuer. Premiums, strikes and withdrawals in USDG fail until it resumes.",
    });
  }
  found.push(...registryConditions(s.markets));
  for (const watch of s.markets) found.push(...watchConditions(s.now, watch, s.market));
  if (s.market !== null) found.push(...marketConditions(s.now, s.market));
  return found;
}

// One market's alerts. A market that couldn't be read, or whose listing differs from the markets
// file, alerts for that alone: the keeper and the maker leave it alone too.
function watchConditions(now: number, w: MarketWatch, m: MarketSnapshot | null): Alert[] {
  const name = w.market.symbol.toLowerCase();
  if (w.unreadable !== null) {
    return [
      {
        key: `market-unreadable:${name}`,
        severity: "page",
        text: `${w.market.symbol} couldn't be read, so nothing else about it is checked: ${w.unreadable}`,
      },
    ];
  }
  if (w.listing !== null) {
    return [
      {
        key: `listing-differs:${name}`,
        severity: "page",
        text: `${w.market.symbol}'s listing in the token registry isn't the markets file's, so the keeper and the maker leave it alone: ${w.listing}`,
      },
    ];
  }
  const found = w.token === null ? [] : tokenConditions(now, w.market, w.token);
  if (m !== null && w.listed !== null) found.push(...listedConditions(now, w.market, w.listed, m));
  return found;
}

function tokenConditions(now: number, market: Market, t: TokenState): Alert[] {
  const { symbol } = market;
  const name = symbol.toLowerCase();
  const found: Alert[] = [];
  if (t.paused) {
    found.push({
      key: `issuer-paused:${name}`,
      severity: "page",
      text: `${symbol} is paused by its issuer. Exercises and withdrawals in ${symbol} fail until it resumes.`,
    });
  }
  if (t.oraclePaused) {
    found.push({
      key: `oracle-paused:${name}`,
      severity: "page",
      text: `${symbol}'s oracle is paused. New fills and epoch creation are refused until it resumes.`,
    });
  }
  if (t.newUIMultiplier !== t.uiMultiplier && t.effectiveAt > now) {
    found.push({
      key: `multiplier-pending:${name}`,
      severity: "warn",
      text: `${symbol}'s multiplier changes from ${t.uiMultiplier.toString()} to ${t.newUIMultiplier.toString()} at ${iso(t.effectiveAt)}.`,
    });
  }
  if (now - t.feedUpdatedAt > market.heartbeatSeconds + FEED_GRACE && inTradingWeek(now)) {
    found.push({
      key: `feed-stale:${name}`,
      severity: "warn",
      text: `The ${symbol} feed hasn't updated since ${iso(t.feedUpdatedAt)} in the trading week.`,
    });
  }
  return found;
}

// Each cap the market holds for a side that isn't the one the markets file sets.
function capDifferences(side: string, onChain: Caps, file: Market["sell"]["caps"]): string[] {
  return CAP_FIELDS.filter((field) => onChain[field] !== file[field]).map(
    (field) =>
      `${side} ${field} is ${onChain[field].toString()} on the market and ${file[field].toString()} in the markets file`,
  );
}

function listedConditions(now: number, market: Market, l: ListedState, m: MarketSnapshot): Alert[] {
  const { symbol } = market;
  const name = symbol.toLowerCase();
  const found: Alert[] = [];
  if (l.assetPaused) {
    found.push({
      key: `market-paused:${name}`,
      severity: "warn",
      text: `New ${symbol} positions are paused.`,
    });
  }
  const opening = m.latestBoundary;
  if (
    opening !== null &&
    l.latestExpiry <= opening.close &&
    now > opening.close + EPOCH_GRACE &&
    now < opening.creationDeadline
  ) {
    found.push({
      key: `epoch-missing:${name}`,
      severity: now >= opening.creationDeadline - EPOCH_PAGE_LEAD ? "page" : "warn",
      text: `No ${symbol} epoch opened at the ${iso(opening.close)} close. Creation closes at ${iso(opening.creationDeadline)}.`,
    });
  }
  // Before the schedule's first close, each market's first week opens through createFirstEpoch.
  const firstCloseAhead = opening === null && m.nextClose !== null;
  const firstWeekFrom = m.deployedAt + m.lookback;
  if (firstCloseAhead && l.latestExpiry === 0 && now >= firstWeekFrom + FIRST_EPOCH_GRACE) {
    found.push({
      key: `first-epoch-missing:${name}`,
      severity: "page",
      text: `${symbol}'s first week hasn't opened, though it could from ${iso(firstWeekFrom)}. The first close is ${iso(m.nextClose)}, and until the week opens no ${symbol} order can fill.`,
    });
  }
  const differences = [
    ...capDifferences("sell", l.caps.sell, market.sell.caps),
    ...capDifferences("buy", l.caps.buy, market.buy.caps),
  ];
  if (differences.length > 0) {
    found.push({
      key: `caps-differ:${name}`,
      severity: "warn",
      text: `${symbol}'s caps on the market aren't the markets file's: ${differences.join("; ")}.`,
    });
  }
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
  if (m.paused) {
    found.push({
      key: "market-paused",
      severity: "warn",
      text: "New positions are paused market-wide.",
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
  BatchBidderSet: "warn",
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
