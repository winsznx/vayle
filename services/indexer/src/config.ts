import { getAddress, type Address } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { MissingSetting } from "./errors.ts";

export interface StoreConfig {
  readonly url: string;
  readonly serviceKey: string;
}

export interface IndexerConfig {
  readonly rpcUrl: string;
  readonly store: StoreConfig;
  readonly chainId: number;
  readonly market: Address;
  // The market's deploy block, where indexing starts.
  readonly startBlock: bigint;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(`set ${name}`);
  return value;
}

export function loadConfig(env: Env): IndexerConfig {
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    store: {
      url: required(env, "SUPABASE_URL"),
      serviceKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    },
    chainId: facts.chain.chainId,
    market: getAddress(required(env, "VAYLE_MARKET")),
    startBlock: BigInt(required(env, "VAYLE_START_BLOCK")),
  };
}
