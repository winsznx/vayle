import { markets as listed, type Market } from "@vayle/markets";
import { getAddress, type Address, type Hex } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { MissingSetting } from "./errors.ts";

export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly key: Hex;
  readonly market: Address;
  readonly liveness: Address;
  readonly calendar: Address;
  // The token registry the market lists its assets in. Each run checks every market's listing there
  // against the markets file.
  readonly registry: Address;
  // Every market in deployments/markets.json, with its token, feed and grid.
  readonly markets: readonly Market[];
  // With a market's token, the terms the market hashes into a series ID that don't come from an
  // order or an epoch: its chain, and the token puts are collateralized in.
  readonly chainId: number;
  readonly usdg: Address;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(`set ${name}`);
  return value;
}

export function loadConfig(env: Env, markets: readonly Market[] = listed): KeeperConfig {
  const key = required(env, "KEEPER_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new MissingSetting("KEEPER_KEY isn't a private key");
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    key: key as Hex,
    market: getAddress(required(env, "VAYLE_MARKET")),
    liveness: getAddress(required(env, "VAYLE_LIVENESS")),
    calendar: getAddress(required(env, "VAYLE_CALENDAR")),
    registry: getAddress(required(env, "VAYLE_REGISTRY")),
    markets,
    chainId: facts.chain.chainId,
    usdg: getAddress(facts.usdg.address),
  };
}
