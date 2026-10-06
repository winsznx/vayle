import { toFunctionSelector, type Hex } from "viem";

// ERC-8056 interface IDs are the XOR of each interface's function selectors (ERC-165). They're
// computed here from the signatures and then checked against the published spec, so a wrong
// signature fails loudly instead of probing the wrong ID.
export const ERC8056_INTERFACES = {
  core: ["uiMultiplier()"],
  pending: ["newUIMultiplier()", "effectiveAt()"],
  balances: ["balanceOfUI(address)", "totalSupplyUI()"],
  conversion: ["toUIAmount(uint256)", "fromUIAmount(uint256)"],
} as const satisfies Record<string, readonly string[]>;

export type Erc8056Interface = keyof typeof ERC8056_INTERFACES;

export function interfaceId(signatures: readonly string[]): Hex {
  let id = 0;
  for (const signature of signatures) {
    id ^= Number.parseInt(toFunctionSelector(`function ${signature}`).slice(2), 16);
  }
  return `0x${(id >>> 0).toString(16).padStart(8, "0")}`;
}

export function erc8056InterfaceIds(): Record<Erc8056Interface, Hex> {
  return {
    core: interfaceId(ERC8056_INTERFACES.core),
    pending: interfaceId(ERC8056_INTERFACES.pending),
    balances: interfaceId(ERC8056_INTERFACES.balances),
    conversion: interfaceId(ERC8056_INTERFACES.conversion),
  };
}
