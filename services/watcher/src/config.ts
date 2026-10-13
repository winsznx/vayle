import { markets as listed, type Market } from "@vayle/markets";
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

// Where alerts go: a Telegram chat through a bot, or a webhook, which can be a Discord one.
export type AlertDestination =
  | { readonly kind: "telegram"; readonly botToken: string; readonly chatId: string }
  | { readonly kind: "webhook"; readonly url: string };

export interface WatcherConfig {
  readonly rpcUrl: string;
  readonly alerts: AlertDestination;
  readonly store: StoreConfig;
  // USDG, from the chain facts. Each token names its own access registry.
  readonly usdg: Address;
  // Every market in deployments/markets.json: its token, its feed with the feed's heartbeat, and the
  // caps the deploy set from the file.
  readonly markets: readonly Market[];
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

// A Telegram bot token and chat together, or else a webhook. Half a Telegram setting is a mistake,
// not a reason to fall back to the webhook.
function alertDestination(env: Env): AlertDestination {
  const botToken = env["WATCHER_TELEGRAM_BOT_TOKEN"] ?? "";
  const chatId = env["WATCHER_TELEGRAM_CHAT_ID"] ?? "";
  if (botToken !== "" || chatId !== "") {
    return {
      kind: "telegram",
      botToken: required(env, "WATCHER_TELEGRAM_BOT_TOKEN"),
      chatId: required(env, "WATCHER_TELEGRAM_CHAT_ID"),
    };
  }
  return { kind: "webhook", url: required(env, "WATCHER_WEBHOOK_URL") };
}

export function loadConfig(env: Env, markets: readonly Market[] = listed): WatcherConfig {
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    alerts: alertDestination(env),
    store: {
      url: required(env, "SUPABASE_URL"),
      serviceKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    usdg: getAddress(facts.usdg.address),
    markets,
    market: marketAddresses(env),
  };
}
