import type { Market } from "@vayle/markets";
import { getAddress, isAddress, type Address } from "viem";

// The market check, deployments/market-check.json: every Stock Token in the issuer's registry with
// what each check found about listing it. A token lists once it passes them all. Read
// defensively: a token entry that doesn't parse is left out, and a file this app can't read, or one
// for another chain, counts as not published.

// The checks every token carries, in the order they're shown. Any further check the file carries
// for a token shows after them, under its own name.
export const REQUIRED_CHECKS = [
  "feed",
  "erc8056",
  "multiplier",
  "pauses",
  "staleness",
  "liquidity",
] as const;

export type CheckStatus = "pass" | "fail" | "not_run";

export interface Check {
  readonly key: string;
  readonly status: CheckStatus;
  readonly reason: string;
}

export interface CheckedToken {
  readonly symbol: string;
  readonly name: string;
  readonly address: Address;
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

export interface MarketCheck {
  readonly chainId: number;
  // When the check ran, in seconds, when the file says.
  readonly generatedAt: number | null;
  readonly block: { readonly number: bigint; readonly timestamp: number } | null;
  readonly tokens: readonly CheckedToken[];
}

type Json = Readonly<Record<string, unknown>>;

const STATUSES: readonly string[] = ["pass", "fail", "not_run"];

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function integer(value: unknown): bigint | null {
  if (typeof value === "string") return /^\d+$/.test(value) ? BigInt(value) : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return null;
}

// A time as seconds or an ISO 8601 string, in seconds.
function seconds(value: unknown): number | null {
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  const n = integer(value);
  return n === null || n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);
}

function isStatus(value: unknown): value is CheckStatus {
  return typeof value === "string" && STATUSES.includes(value);
}

function checkOf(key: string, value: unknown): Check | null {
  const json = record(value);
  const status = json?.["status"];
  const reason = json?.["reason"];
  if (!isStatus(status)) return null;
  return { key, status, reason: typeof reason === "string" ? reason : "" };
}

// The required checks in order, then the rest; null when a required one is missing or any check
// doesn't parse.
function checksOf(checks: Json): Check[] | null {
  const extra = Object.keys(checks).filter(
    (k) => !(REQUIRED_CHECKS as readonly string[]).includes(k),
  );
  const parsed = [...REQUIRED_CHECKS, ...extra].map((key) => checkOf(key, checks[key]));
  return parsed.every((c): c is Check => c !== null) ? parsed : null;
}

function tokenOf(value: unknown): CheckedToken | null {
  const json = record(value);
  const checks = record(json?.["checks"]);
  if (json === null || checks === null) return null;
  const { symbol, name, address, passed } = json;
  if (typeof symbol !== "string" || symbol === "" || typeof name !== "string") return null;
  if (typeof address !== "string" || !isAddress(address, { strict: false })) return null;
  if (typeof passed !== "boolean") return null;
  const parsed = checksOf(checks);
  if (parsed === null) return null;
  return { symbol, name, address: getAddress(address), checks: parsed, passed };
}

export function parseMarketCheck(value: unknown, chainId: number): MarketCheck | null {
  const json = record(value);
  if (json?.["schemaVersion"] !== 1 || !Array.isArray(json["tokens"])) return null;
  const fileChain = integer(json["chainId"]);
  if (fileChain === null || Number(fileChain) !== chainId) return null;
  const block = record(json["block"]);
  const number = integer(block?.["number"]);
  const timestamp = seconds(block?.["timestamp"]);
  return {
    chainId,
    generatedAt: seconds(json["generatedAt"]),
    block: number === null || timestamp === null ? null : { number, timestamp },
    tokens: (json["tokens"] as unknown[]).flatMap((entry) => {
      const token = tokenOf(entry);
      return token === null ? [] : [token];
    }),
  };
}

// Every checked token the build doesn't list, those closest to listing first: the ones that passed,
// then by how many checks passed, then by ticker.
export function notListed(check: MarketCheck, markets: readonly Market[]): CheckedToken[] {
  const listed = new Set(markets.map((m) => m.token));
  const passes = (t: CheckedToken): number => t.checks.filter((c) => c.status === "pass").length;
  return check.tokens
    .filter((t) => !listed.has(t.address))
    .sort(
      (a, b) =>
        Number(b.passed) - Number(a.passed) ||
        passes(b) - passes(a) ||
        a.symbol.localeCompare(b.symbol),
    );
}
