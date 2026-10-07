import { getAddress, type Address } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { MarketConfigIncomplete, MissingSetting } from "./errors.ts";

// The chain's block explorer, from the chain facts.
export const EXPLORER = facts.chain.explorerUrl;

export interface MarketAddresses {
  readonly market: Address;
  readonly liveness: Address;
  readonly calendar: Address;
  readonly registry: Address;
  // The block the market was deployed at, where log scanning starts.
  readonly startBlock: bigint;
}

export interface StoreConfig {
  readonly url: string;
  readonly serviceKey: string;
}

export interface WatcherConfig {
  readonly rpcUrl: string;
  readonly webhookUrl: string;
  readonly store: StoreConfig;
  readonly nvda: Address;
  readonly nvdaAccessRegistry: Address;
  readonly usdg: Address;
  readonly nvdaFeed: Address;
  // Unset until the contracts are deployed. The watcher then covers dependencies only.
  readonly market: MarketAddresses | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const MARKET_SETTINGS = [
  "VAYLE_MARKET",
  "VAYLE_LIVENESS",
  "VAYLE_CALENDAR",
  "VAYLE_REGISTRY",
  "VAYLE_START_BLOCK",
] as const;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(`set ${name}`);
  return value;
}

function marketAddresses(env: Env): MarketAddresses | null {
  const set = MARKET_SETTINGS.filter((name) => (env[name] ?? "") !== "");
  if (set.length === 0) return null;
  if (set.length !== MARKET_SETTINGS.length) {
    const missing = MARKET_SETTINGS.filter((name) => !set.includes(name));
    throw new MarketConfigIncomplete(
      `set all market settings or none; missing ${missing.join(", ")}`,
    );
  }
  return {
    market: getAddress(required(env, "VAYLE_MARKET")),
    liveness: getAddress(required(env, "VAYLE_LIVENESS")),
    calendar: getAddress(required(env, "VAYLE_CALENDAR")),
    registry: getAddress(required(env, "VAYLE_REGISTRY")),
    startBlock: BigInt(required(env, "VAYLE_START_BLOCK")),
  };
}

export function loadConfig(env: Env): WatcherConfig {
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    webhookUrl: required(env, "WATCHER_WEBHOOK_URL"),
    store: {
      url: required(env, "SUPABASE_URL"),
      serviceKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    nvda: getAddress(facts.nvda.address),
    nvdaAccessRegistry: getAddress(facts.nvda.accessRegistry),
    usdg: getAddress(facts.usdg.address),
    nvdaFeed: getAddress(facts.nvdaUsdFeed.proxy),
    market: marketAddresses(env),
  };
}
