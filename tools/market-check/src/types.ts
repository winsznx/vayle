import type { Address, Hex } from "viem";

// The shape of deployments/market-check.json. Other code reads these names, so they stay fixed.
// Raw onchain integers are decimal strings, and times are unix seconds.

export type Status = "pass" | "fail" | "not_run";

export interface Check {
  readonly status: Status;
  // Empty on a pass.
  readonly reason: string;
}

export interface FeedCheck extends Check {
  readonly proxy: Address | null;
  readonly heartbeatSeconds: number | null;
  readonly deviationThresholdPercent: number | null;
  readonly marketHours: string | null;
}

export interface Erc8056Check extends Check {
  readonly core: boolean | null;
  readonly balances: boolean | null;
  readonly pending: boolean | null;
  readonly conversion: boolean | null;
}

export interface MultiplierCheck extends Check {
  readonly uiMultiplier: string | null;
  readonly newUIMultiplier: string | null;
  readonly effectiveAt: number | null;
}

export interface PausesCheck extends Check {
  readonly oraclePaused: boolean | null;
  readonly paused: boolean | null;
  readonly registryPaused: boolean | null;
}

export type UidCheck = Check;

export interface StalenessCheck extends Check {
  // Information only: the longest stretch of regular-hours time between consecutive updates.
  readonly maxRegularHoursGapSeconds: number | null;
  // The same over the feed's own market hours, which the pass rule holds to the heartbeat.
  readonly maxMarketHoursGapSeconds: number | null;
  readonly maxAgeAtCloseSeconds: number | null;
  readonly roundsRead: number | null;
}

// One pool a route passes through. v2 and v3 pools are contracts. A v4 pool is the ID the pool
// manager keys it by, with the key that hashes to it.
export interface PoolLeg {
  readonly protocol: Venue;
  readonly pool: Hex;
  readonly fee: number | null;
  readonly tickSpacing: number | null;
  readonly hooks: Address | null;
}

export type Venue = "uniswap-v2" | "uniswap-v3" | "uniswap-v4";

export interface LiquidityCheck extends Check {
  readonly venue: Venue | null;
  readonly route: readonly Address[] | null;
  readonly pools: readonly PoolLeg[] | null;
  readonly capSizeRaw: string | null;
  readonly usdgOut: string | null;
  readonly slippageBps: number | null;
  readonly maxSizeWithinLimitRaw: string | null;
}

export interface Checks {
  readonly feed: FeedCheck;
  readonly erc8056: Erc8056Check;
  readonly multiplier: MultiplierCheck;
  readonly pauses: PausesCheck;
  readonly uid: UidCheck;
  readonly staleness: StalenessCheck;
  readonly liquidity: LiquidityCheck;
}

export interface Price {
  readonly answer: string;
  readonly decimals: number;
  readonly updatedAt: number;
  readonly usd: string;
}

// Not a check: it never decides whether a token passes.
export interface RealizedVol {
  readonly status: "ok" | "not_run";
  readonly reason: string;
  readonly sessions: number;
  readonly closes: number | null;
  readonly annualizedBps: number | null;
}

export interface TokenResult {
  readonly symbol: string;
  readonly name: string | null;
  readonly address: Address;
  readonly uid: Hex | null;
  readonly decimals: number;
  readonly registryStatus: string;
  readonly price: Price | null;
  readonly realizedVol: RealizedVol;
  readonly proposedStrikeStep: string | null;
  readonly checks: Checks;
  readonly passed: boolean;
}

export interface Criteria {
  readonly maxGapRule: "heartbeat";
  readonly maxAgeAtCloseSeconds: number;
  readonly sessions: number;
  readonly realizedVolSessions: number;
  readonly capUsd: number;
  readonly maxSlippageBps: number;
  readonly strikeStepPercentOfPrice: number;
}

// A contract the check reads that isn't a Stock Token, with the page its address came from and
// the size of the code found there at the pinned block.
export interface ContractRecord {
  readonly address: Address;
  readonly source: string;
  readonly codeBytes: number;
}

export interface MarketCheck {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly chainId: number;
  readonly block: { readonly number: string; readonly timestamp: number };
  readonly sources: {
    readonly stockTokens: string;
    readonly feeds: string;
    readonly dexes: readonly string[];
  };
  readonly criteria: Criteria;
  readonly contracts: Readonly<Record<string, ContractRecord>>;
  readonly tokens: readonly TokenResult[];
}
