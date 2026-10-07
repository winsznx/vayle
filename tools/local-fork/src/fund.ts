import { erc20Abi, type Address } from "viem";
import type { ForkClient } from "./anvil.ts";
import { FundingSourceShort } from "./errors.ts";

// Held about 24,527 raw NVDA and 52.2M USDG at block 81959622 (balanceOf reads, 2026-10-06). The
// fork tests fund their wallets from it as well (contracts/test/utils/ChainActors.sol).
// https://robinhoodchain.blockscout.com/address/0x8366a39CC670B4001A1121B8F6A443A643e40951
export const FUNDING_SOURCE: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

export interface Grant {
  readonly to: Address;
  readonly token: Address;
  readonly amount: bigint;
}

// Moves real balances on the fork by impersonating the funding source. Checks it holds enough
// first, so a drained source fails by name instead of with a bare revert.
export async function fund(client: ForkClient, grants: readonly Grant[]): Promise<void> {
  const needed = new Map<Address, bigint>();
  for (const g of grants) needed.set(g.token, (needed.get(g.token) ?? 0n) + g.amount);
  for (const [token, amount] of needed) {
    const held = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [FUNDING_SOURCE],
    });
    if (held < amount) {
      throw new FundingSourceShort(`${FUNDING_SOURCE} holds ${held} of ${token}, needs ${amount}`);
    }
  }
  await client.impersonateAccount({ address: FUNDING_SOURCE });
  try {
    for (const g of grants) {
      const hash = await client.writeContract({
        account: FUNDING_SOURCE,
        address: g.token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [g.to, g.amount],
      });
      await client.waitForTransactionReceipt({ hash });
    }
  } finally {
    await client.stopImpersonatingAccount({ address: FUNDING_SOURCE });
  }
}
