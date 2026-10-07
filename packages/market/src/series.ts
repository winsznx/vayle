import { encodeAbiParameters, keccak256, type Address } from "viem";

// A series ID is the hash of every term of the option, so it can be worked out without asking the
// chain. A fork test checks this against the market for real series.

export interface SeriesTerms {
  readonly chainId: bigint;
  readonly asset: Address;
  readonly side: number;
  readonly strike: bigint;
  readonly expiry: bigint;
  readonly windowLength: number;
  // Calls are collateralized in the asset, puts in USDG.
  readonly collateralToken: Address;
}

// Raw token units, European, physical delivery, idle collateral: the only terms the market lists.
const RAW_UNITS = 1;
const EUROPEAN = 0;
const PHYSICAL = 0;
const IDLE = 0;

const KEY = [
  {
    type: "tuple",
    components: [
      { name: "chainId", type: "uint256" },
      { name: "asset", type: "address" },
      { name: "optionType", type: "uint8" },
      { name: "strike", type: "uint256" },
      { name: "expiry", type: "uint64" },
      { name: "windowLength", type: "uint32" },
      { name: "unitBasis", type: "uint8" },
      { name: "exerciseStyle", type: "uint8" },
      { name: "settlementType", type: "uint8" },
      { name: "collateralToken", type: "address" },
      { name: "collateralMode", type: "uint8" },
    ],
  },
] as const;

export function seriesId(terms: SeriesTerms): bigint {
  const encoded = encodeAbiParameters(KEY, [
    {
      chainId: terms.chainId,
      asset: terms.asset,
      optionType: terms.side,
      strike: terms.strike,
      expiry: terms.expiry,
      windowLength: terms.windowLength,
      unitBasis: RAW_UNITS,
      exerciseStyle: EUROPEAN,
      settlementType: PHYSICAL,
      collateralToken: terms.collateralToken,
      collateralMode: IDLE,
    },
  ]);
  return BigInt(keccak256(encoded));
}
