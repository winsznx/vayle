import type { MarketEvent } from "@vayle/market";

// What the proof page shows about the market's life on mainnet, worked out from its events alone:
// every transaction that touched it, and who set targets.

export interface TeamWallet {
  readonly address: string;
  readonly label: string;
}

export interface ProofTransaction {
  readonly hash: string;
  readonly block: number;
  readonly time: string;
  // The market's events in the transaction, in log order.
  readonly events: readonly string[];
  // The wallet the transaction is about: the account its first event names, if any.
  readonly account: string | null;
  // The team wallet's label when the account is one, null for anyone else.
  readonly team: string | null;
}

export interface Wallets {
  // Every distinct address that set a target.
  readonly total: number;
  readonly team: number;
  readonly outside: number;
  readonly outsideAddresses: readonly string[];
}

// Settings only the owner can change. A transaction of nothing but these was the owner acting
// through the timelock, whatever address an event names.
const OWNER_EVENTS: ReadonlySet<string> = new Set([
  "OwnershipTransferred",
  "OwnershipTransferStarted",
  "GuardianSet",
  "FeeSet",
  "CapsSet",
  "TeamOperatedSet",
  "BatchBidderSet",
  "HaltRenewed",
]);
export const OWNER_LABEL = "Owner, through the timelock";

// Each transaction once, newest first, with its events in order.
export function transactionsOf(
  events: readonly MarketEvent[],
  team: readonly TeamWallet[],
): ProofTransaction[] {
  const labels = new Map(team.map((w) => [w.address.toLowerCase(), w.label]));
  const byHash = new Map<string, MarketEvent[]>();
  for (const e of events) {
    const list = byHash.get(e.tx_hash);
    if (list === undefined) byHash.set(e.tx_hash, [e]);
    else list.push(e);
  }
  return [...byHash.entries()]
    .map(([hash, list]) => {
      const sorted = [...list].sort((a, b) => a.log_index - b.log_index);
      const first = sorted[0];
      const byOwner = sorted.every((e) => OWNER_EVENTS.has(e.name));
      const account = byOwner ? null : (sorted.find((e) => e.account !== null)?.account ?? null);
      return {
        hash,
        block: first?.block_number ?? 0,
        time: first?.block_time ?? "",
        events: sorted.map((e) => e.name),
        account,
        team: byOwner ? OWNER_LABEL : account === null ? null : (labels.get(account) ?? null),
      };
    })
    .sort((a, b) => b.block - a.block || b.hash.localeCompare(a.hash));
}

// The wallets that set targets, split into the team's and everyone else's.
export function walletsOf(events: readonly MarketEvent[], team: readonly TeamWallet[]): Wallets {
  const teamSet = new Set(team.map((w) => w.address.toLowerCase()));
  const owners = new Set(
    events
      .filter((e) => e.name === "OrderPlaced" && e.account !== null)
      .map((e) => e.account as string),
  );
  const outsideAddresses = [...owners].filter((a) => !teamSet.has(a)).sort();
  return {
    total: owners.size,
    team: owners.size - outsideAddresses.length,
    outside: outsideAddresses.length,
    outsideAddresses,
  };
}

// How many of each lifecycle step happened, for the page's summary.
export function countsOf(events: readonly MarketEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.name] = (counts[e.name] ?? 0) + 1;
  return counts;
}
