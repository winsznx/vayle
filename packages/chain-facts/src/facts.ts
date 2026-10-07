import type { Address, Hex } from "viem";

export interface ChainFacts {
  readonly schemaVersion: 1;
  readonly network: "robinhood-mainnet";
  readonly generatedAt: string;
  // Every onchain value in this file was read at this block.
  readonly block: { readonly number: string; readonly hash: Hex; readonly timestamp: number };
  readonly chain: {
    readonly chainId: number;
    readonly arbOsVersion: number;
    // The largest contract runtime and init code a CREATE accepts, in bytes.
    readonly maxCodeSize: number;
    readonly maxInitCodeSize: number;
    // The public RPC and the block explorer the chain's docs list. Wallets get these when they add
    // the chain, never a private RPC.
    readonly publicRpcUrl: string;
    readonly explorerUrl: string;
    readonly sources: readonly string[];
  };
  readonly nvda: {
    readonly address: Address;
    readonly uid: Hex;
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly registryStatus: string;
    readonly uiMultiplier: string;
    readonly newUIMultiplier: string;
    readonly effectiveAt: number;
    readonly oraclePaused: boolean;
    readonly paused: boolean;
    readonly interfaces: Readonly<Record<"core" | "pending" | "balances" | "conversion", boolean>>;
    readonly beacon: Address;
    readonly implementation: Address;
    readonly accessRegistry: Address;
    readonly accessRegistryPaused: boolean;
    readonly sources: readonly string[];
  };
  readonly usdg: {
    readonly address: Address;
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly paused: boolean;
    readonly implementation: Address;
    readonly domainSeparator: Hex;
    readonly domainVersion: string;
    readonly rewardsFacet: boolean;
    readonly sources: readonly string[];
  };
  readonly nvdaUsdFeed: {
    readonly name: string;
    readonly proxy: Address;
    readonly svrProxy: Address | null;
    readonly aggregator: Address;
    // Who may read the feed. Zero, for anyone, is what batched reads through Multicall3 rely on.
    readonly accessController: Address;
    readonly aggregatorTypeAndVersion: string;
    readonly description: string;
    readonly decimals: number;
    readonly heartbeatSeconds: number;
    readonly deviationThresholdPercent: number;
    readonly marketHours: string;
    readonly latestRound: {
      readonly roundId: string;
      readonly answer: string;
      readonly startedAt: number;
      readonly updatedAt: number;
    };
    readonly sources: readonly string[];
  };
  readonly sequencerUptimeFeed: {
    readonly available: boolean;
    readonly sources: readonly string[];
  };
  // The batching contract every client reads through. Its runtime code must hash to the canonical
  // Multicall3 deployment's, and it must have code from blockCreated on.
  readonly multicall3: {
    readonly address: Address;
    readonly blockCreated: number;
    readonly runtimeKeccak: Hex;
    readonly sources: readonly string[];
  };
  readonly erc8056: {
    readonly interfaceIds: Readonly<Record<"core" | "pending" | "balances" | "conversion", Hex>>;
    readonly sources: readonly string[];
  };
}

// Values that change in normal operation. A difference in anything else is drift.
export const VOLATILE_PATHS: readonly string[] = [
  "generatedAt",
  "block",
  "nvda.uiMultiplier",
  "nvda.newUIMultiplier",
  "nvda.effectiveAt",
  "nvda.oraclePaused",
  "nvda.paused",
  "nvda.accessRegistryPaused",
  "usdg.paused",
  "nvdaUsdFeed.latestRound",
];

export interface Difference {
  readonly path: string;
  readonly committed: unknown;
  readonly current: unknown;
  readonly volatile: boolean;
}

function isVolatile(path: string): boolean {
  return VOLATILE_PATHS.some((v) => path === v || path.startsWith(`${v}.`));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diffFacts(committed: unknown, current: unknown, path = ""): Difference[] {
  if (isPlainObject(committed) && isPlainObject(current)) {
    const keys = new Set([...Object.keys(committed), ...Object.keys(current)]);
    return [...keys].flatMap((key) =>
      diffFacts(committed[key], current[key], path === "" ? key : `${path}.${key}`),
    );
  }
  if (JSON.stringify(committed) === JSON.stringify(current)) return [];
  return [{ path, committed, current, volatile: isVolatile(path) }];
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

export function serializeFacts(facts: ChainFacts): string {
  return `${JSON.stringify(sortKeys(facts), null, 2)}\n`;
}
