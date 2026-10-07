import type { Call } from "@vayle/market";
import { useMemo } from "react";
import type { Address, Chain, Hash } from "viem";
import { useAccount, useConfig } from "wagmi";
import { sendTransaction } from "wagmi/actions";

// What the rest of the app needs from a wallet: who's connected, on which chain, and a way to send
// one prepared call with a gas limit. The connection itself is wagmi's, opened through RainbowKit's
// modal from the top bar.
export interface Wallet {
  readonly address: Address | null;
  readonly chainId: number | null;
  send(call: Call, gas: bigint): Promise<Hash>;
}

export class WalletNotConnected extends Error {
  override readonly name = "WalletNotConnected";
}

export function useWallet(chain: Chain): Wallet {
  const config = useConfig();
  const { address, chainId } = useAccount();
  return useMemo(
    () => ({
      address: address ?? null,
      chainId: chainId ?? null,
      // The app estimates gas itself and passes the limit. The chain ID makes viem check the wallet
      // is on Robinhood Chain before anything is signed, and the account makes wagmi check it's
      // still the connected one.
      send: (call: Call, gas: bigint) => {
        if (address === undefined) throw new WalletNotConnected("Connect a wallet first.");
        return sendTransaction(config, {
          account: address,
          chainId: chain.id,
          to: call.to,
          data: call.data,
          gas,
        });
      },
    }),
    [config, address, chainId, chain.id],
  );
}
