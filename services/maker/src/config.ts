import { markets as listed, type Market } from "@vayle/markets";
import { getAddress, type Address, type Hex } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { BadSetting, MissingSetting } from "./errors.ts";

// The pricing inputs every market shares. Each market's volatility comes from the markets file.
export interface PricingConfig {
  // Annualized, as fractions: 0.04 is 4%.
  readonly grossDividendYield: number;
  readonly rate: number;
  // How far under fair value the maker bids, in basis points.
  readonly edgeBps: number;
  readonly rfq: boolean;
}

export interface MakerConfig {
  readonly rpcUrl: string;
  // The chain the maker signs quotes for, from the chain facts. Quote signatures commit to it.
  readonly chainId: number;
  readonly key: Hex;
  readonly market: Address;
  // The token registry the market lists its assets in. Each run checks every market's listing there
  // against the markets file.
  readonly registry: Address;
  readonly usdg: Address;
  readonly usdgDecimals: number;
  // Every market in deployments/markets.json: its token, feed and grid, the sides it trades, the
  // caps it sizes against and the volatility it prices with.
  readonly markets: readonly Market[];
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
export function loadConfig(env: Env, markets: readonly Market[] = listed): MakerConfig {
  const key = required(env, "MAKER_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new BadSetting("MAKER_KEY isn't a private key");
  const rfq = required(env, "MAKER_RFQ");
  if (rfq !== "on" && rfq !== "off") throw new BadSetting("MAKER_RFQ must be on or off");
  return {
    rpcUrl: required(env, "ROBINHOOD_RPC_URL"),
    chainId: facts.chain.chainId,
    key: key as Hex,
    market: getAddress(required(env, "VAYLE_MARKET")),
    registry: getAddress(required(env, "VAYLE_REGISTRY")),
    usdg: getAddress(facts.usdg.address),
    usdgDecimals: facts.usdg.decimals,
    markets,
    pricing: {
      grossDividendYield: bps(env, "MAKER_DIVIDEND_YIELD_BPS", 10_000) / 10_000,
      rate: bps(env, "MAKER_RATE_BPS", 10_000) / 10_000,
      edgeBps: bps(env, "MAKER_EDGE_BPS", 9_999),
      rfq: rfq === "on",
    },
  };
}
