import { useAccountModal, useChainModal, useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount, useSwitchChain } from "wagmi";
import { useApp } from "../state.tsx";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// One button for the wallet. Disconnected, it opens the wallet list. Connected on Robinhood Chain,
// it shows the account and opens its menu. On another chain, it asks to switch, and adds the chain
// to the wallet with its public RPC if the wallet doesn't know it.
export function ConnectButton() {
  const { config, chain } = useApp();
  const { address, chainId, status } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { openAccountModal } = useAccountModal();
  const { openChainModal } = useChainModal();
  const { switchChain, isPending, error } = useSwitchChain();

  if (address === undefined) {
    const busy = status === "connecting" || status === "reconnecting";
    return (
      <button
        type="button"
        className="btn btn-ink"
        disabled={busy || openConnectModal === undefined}
        aria-busy={busy}
        onClick={() => openConnectModal?.()}
      >
        {busy ? "Connecting" : "Connect wallet"}
      </button>
    );
  }

  const onChain = chainId === config.chainId;
  const explorer = chain.blockExplorers?.default.url;
  return (
    <>
      {!onChain && (
        <button
          type="button"
          className="btn btn-brand"
          disabled={isPending}
          onClick={() => {
            switchChain({
              chainId: config.chainId,
              addEthereumChainParameter: {
                chainName: chain.name,
                nativeCurrency: chain.nativeCurrency,
                rpcUrls: chain.rpcUrls.default.http,
                ...(explorer === undefined ? {} : { blockExplorerUrls: [explorer] }),
              },
            });
          }}
        >
          Switch to Robinhood Chain
        </button>
      )}
      <button
        type="button"
        className="account-pill"
        aria-label={`Wallet ${address}`}
        onClick={() => (onChain ? openAccountModal?.() : openChainModal?.())}
      >
        <span className="account-dot" aria-hidden="true" />
        <span className="num">{short(address)}</span>
      </button>
      {error !== null && (
        <p className="topbar-problem" role="alert">
          {error.name === "UserRejectedRequestError"
            ? "The switch was declined in the wallet."
            : error.message.split("\n")[0]}
        </p>
      )}
    </>
  );
}
