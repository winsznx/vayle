import type { DirectoryFeed } from "@vayle/chain-facts/sources";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import type { Read } from "./rpc.ts";
import type {
  Check,
  Erc8056Check,
  FeedCheck,
  MultiplierCheck,
  PausesCheck,
  Status,
  UidCheck,
} from "./types.ts";
import type { Round } from "./probes.ts";

// The cheap checks' pass rules, as pure functions of what the chain answered. A read the chain
// answered with a revert fails its check, since the token or feed doesn't do what the market needs.
// A read the run couldn't make leaves its check not run.

function status(failures: readonly string[], unavailable: readonly string[]): Check {
  if (unavailable.length > 0) return { status: "not_run", reason: unavailable.join("; ") };
  if (failures.length > 0) return { status: "fail", reason: failures.join("; ") };
  return { status: "pass", reason: "" };
}

// Collects why a set of reads can't pass: the reverts as failures, the missing ones as unavailable.
class Verdict {
  readonly failures: string[] = [];
  readonly unavailable: string[] = [];

  value<T>(label: string, read: Read<T>): T | null {
    if (read.ok) return read.value;
    if (read.kind === "unavailable") this.unavailable.push(`${label}: ${read.error}`);
    else this.failures.push(`${label} ${read.error}`);
    return null;
  }

  fail(reason: string): void {
    this.failures.push(reason);
  }

  get check(): Check {
    return status(this.failures, this.unavailable);
  }
}

export interface FeedReads {
  readonly accessController: Read<Address>;
  readonly decimals: Read<number>;
  readonly aggregator: Read<Address>;
  readonly latestRound: Read<Round>;
}

// A primaryTokenizedPrice feed is listed for the token, its proxy reports the listed decimals and
// aggregator and a positive answer, and anyone may read it: accessController() is zero or the
// proxy has none. Vayle's contracts read the feed directly.
export function judgeFeed(listing: DirectoryFeed | string, reads: FeedReads | null): FeedCheck {
  if (typeof listing === "string" || reads === null) {
    return {
      status: "fail",
      reason: typeof listing === "string" ? listing : "no reads",
      proxy: null,
      heartbeatSeconds: null,
      deviationThresholdPercent: null,
      marketHours: null,
    };
  }
  const verdict = new Verdict();
  if (reads.accessController.ok && reads.accessController.value !== zeroAddress) {
    verdict.fail(`the proxy's accessController() is ${reads.accessController.value}`);
  } else if (!reads.accessController.ok && reads.accessController.kind === "unavailable") {
    verdict.value("accessController()", reads.accessController);
  }
  const decimals = verdict.value("decimals()", reads.decimals);
  if (decimals !== null && decimals !== listing.decimals) {
    verdict.fail(`the proxy reports ${decimals} decimals, the directory ${listing.decimals}`);
  }
  const aggregator = verdict.value("aggregator()", reads.aggregator);
  if (aggregator !== null && getAddress(aggregator) !== listing.aggregator) {
    verdict.fail(`the proxy reads aggregator ${aggregator}, the directory ${listing.aggregator}`);
  }
  const latest = verdict.value("latestRoundData()", reads.latestRound);
  if (latest !== null && latest.answer <= 0n) {
    verdict.fail(`the latest answer is ${latest.answer}`);
  }
  return {
    ...verdict.check,
    proxy: listing.proxy,
    heartbeatSeconds: listing.heartbeatSeconds,
    deviationThresholdPercent: listing.deviationThresholdPercent,
    marketHours: listing.marketHours,
  };
}

export interface Erc8056Reads {
  readonly core: Read<boolean>;
  readonly balances: Read<boolean>;
  readonly pending: Read<boolean>;
  readonly conversion: Read<boolean>;
}

const REQUIRED_8056 = ["core", "balances", "pending"] as const;

// supportsInterface for the recorded ERC-8056 interface IDs. Core, balances and pending are
// required. Conversion is recorded.
export function judgeErc8056(reads: Erc8056Reads): Erc8056Check {
  const verdict = new Verdict();
  const answers = {
    core: verdict.value("supportsInterface(core)", reads.core),
    balances: verdict.value("supportsInterface(balances)", reads.balances),
    pending: verdict.value("supportsInterface(pending)", reads.pending),
    conversion: reads.conversion.ok ? reads.conversion.value : null,
  };
  for (const key of REQUIRED_8056) {
    if (answers[key] === false) verdict.fail(`the ${key} interface isn't supported`);
  }
  return { ...verdict.check, ...answers };
}

export interface MultiplierReads {
  readonly uiMultiplier: Read<bigint>;
  readonly newUIMultiplier: Read<bigint>;
  readonly effectiveAt: Read<bigint>;
}

// Fails when a different multiplier is set to take effect after `now`.
export function judgeMultiplier(reads: MultiplierReads, now: number): MultiplierCheck {
  const verdict = new Verdict();
  const current = verdict.value("uiMultiplier()", reads.uiMultiplier);
  const next = verdict.value("newUIMultiplier()", reads.newUIMultiplier);
  const effectiveAt = verdict.value("effectiveAt()", reads.effectiveAt);
  if (current !== null && next !== null && effectiveAt !== null) {
    if (next !== current && effectiveAt > BigInt(now)) {
      verdict.fail(`a multiplier of ${next} replaces ${current} at ${effectiveAt}`);
    }
  }
  return {
    ...verdict.check,
    uiMultiplier: current?.toString() ?? null,
    newUIMultiplier: next?.toString() ?? null,
    effectiveAt: effectiveAt === null ? null : Number(effectiveAt),
  };
}

export interface PauseReads {
  readonly oraclePaused: Read<boolean>;
  readonly paused: Read<boolean>;
  readonly registryPaused: Read<boolean>;
}

// The token's oracle flag, the token's pause and its access registry's pause are all clear.
export function judgePauses(reads: PauseReads): PausesCheck {
  const verdict = new Verdict();
  const answers = {
    oraclePaused: verdict.value("oraclePaused()", reads.oraclePaused),
    paused: verdict.value("paused()", reads.paused),
    registryPaused: verdict.value("the access registry's paused()", reads.registryPaused),
  };
  if (answers.oraclePaused === true) verdict.fail("oraclePaused() is true");
  if (answers.paused === true) verdict.fail("the token is paused");
  if (answers.registryPaused === true) verdict.fail("the token's access registry is paused");
  return { ...verdict.check, ...answers };
}

export interface IdentityReads {
  readonly uid: Read<Hex>;
  readonly decimals: Read<number>;
}

// uid() is the registry's id for the asset, compared case-insensitively as the chain facts compare
// NVDA's, and decimals() is the registry's tokenDecimals.
export function judgeUid(
  reads: IdentityReads,
  registryId: string,
  registryDecimals: number,
): UidCheck {
  const verdict = new Verdict();
  const uid = verdict.value("uid()", reads.uid);
  if (uid !== null && uid.toLowerCase() !== registryId.toLowerCase()) {
    verdict.fail(`uid() ${uid} differs from the registry id ${registryId}`);
  }
  const decimals = verdict.value("decimals()", reads.decimals);
  if (decimals !== null && decimals !== registryDecimals) {
    verdict.fail(`decimals() ${decimals}, the registry ${registryDecimals}`);
  }
  return verdict.check;
}

export function notRun(reason: string): Check {
  return { status: "not_run", reason };
}

export function passed(statuses: readonly Status[]): boolean {
  return statuses.every((s) => s === "pass");
}
