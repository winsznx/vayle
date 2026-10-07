import { getAddress, type Address, type Hex } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { MissingSetting } from "./errors.ts";

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly key: Hex;
  readonly market: Address;
  readonly liveness: Address;
  readonly calendar: Address;
  readonly asset: Address;
  readonly feed: Address;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(`set ${name}`);
  return value;
}

export function loadConfig(env: Env): KeeperConfig {
  const key = required(env, "KEEPER_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new MissingSetting("KEEPER_KEY isn't a private key");
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    key: key as Hex,
    market: getAddress(required(env, "VAYLE_MARKET")),
    liveness: getAddress(required(env, "VAYLE_LIVENESS")),
    calendar: getAddress(required(env, "VAYLE_CALENDAR")),
    asset: getAddress(facts.nvda.address),
    feed: getAddress(facts.nvdaUsdFeed.proxy),
  };
}
