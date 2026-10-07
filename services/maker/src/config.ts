import { getAddress, type Address, type Hex } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { BadSetting, MissingSetting } from "./errors.ts";

export interface PricingConfig {
  // Annualized, as fractions: 0.45 is 45%.
  readonly vol: number;
  readonly grossDividendYield: number;
  readonly rate: number;
  // How far under fair value the maker bids, in basis points.
  readonly edgeBps: number;
  // The most the maker buys in one series, in raw units.
  readonly maxPerSeries: bigint;
  readonly rfq: boolean;
}

export interface MakerConfig {
  readonly rpcUrl: string;
  readonly key: Hex;
  readonly market: Address;
  readonly asset: Address;
  readonly feed: Address;
  readonly usdg: Address;
  readonly usdgDecimals: number;
  readonly pricing: PricingConfig;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new MissingSetting(`set ${name}`);
  return value;
}

function bps(env: Env, name: string, max: number): number {
  const value = Number(required(env, name));
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new BadSetting(`${name} must be whole basis points from 0 to ${max}`);
  }
  return value;
}

// Every pricing input is required. A maker with a missing number stays out instead of guessing.
export function loadConfig(env: Env): MakerConfig {
  const key = required(env, "MAKER_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new BadSetting("MAKER_KEY isn't a private key");
  const vol = bps(env, "MAKER_VOL_BPS", 50_000);
  if (vol === 0) throw new BadSetting("MAKER_VOL_BPS must be above zero");
  const rfq = required(env, "MAKER_RFQ");
  if (rfq !== "on" && rfq !== "off") throw new BadSetting("MAKER_RFQ must be on or off");
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    key: key as Hex,
    market: getAddress(required(env, "VAYLE_MARKET")),
    asset: getAddress(facts.nvda.address),
    feed: getAddress(facts.nvdaUsdFeed.proxy),
    usdg: getAddress(facts.usdg.address),
    usdgDecimals: facts.usdg.decimals,
    pricing: {
      vol: vol / 10_000,
      grossDividendYield: bps(env, "MAKER_DIVIDEND_YIELD_BPS", 10_000) / 10_000,
      rate: bps(env, "MAKER_RATE_BPS", 10_000) / 10_000,
      edgeBps: bps(env, "MAKER_EDGE_BPS", 9_999),
      maxPerSeries: BigInt(required(env, "MAKER_MAX_PER_SERIES")),
      rfq: rfq === "on",
    },
  };
}
