import type { EIP1193Provider } from "viem";

// Browser wallets: the ones that announce themselves (EIP-6963), and window.ethereum for wallets
// that only inject.

export interface Wallet {
  readonly id: string;
  readonly name: string;
  readonly provider: EIP1193Provider;
}

function isProvider(value: unknown): value is EIP1193Provider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { request?: unknown }).request === "function"
  );
}

function announced(detail: unknown): Wallet | null {
  if (typeof detail !== "object" || detail === null) return null;
  const { info, provider } = detail as { info?: unknown; provider?: unknown };
  if (typeof info !== "object" || info === null || !isProvider(provider)) return null;
  const { uuid, name } = info as { uuid?: unknown; name?: unknown };
  if (typeof uuid !== "string" || typeof name !== "string") return null;
  return { id: uuid, name, provider };
}

// Calls onChange with every wallet found so far, now and whenever another one announces itself.
export function watchWallets(onChange: (wallets: readonly Wallet[]) => void): void {
  const found = new Map<string, Wallet>();
  const injected: unknown = (window as { ethereum?: unknown }).ethereum;
  if (isProvider(injected)) {
    found.set("injected", { id: "injected", name: "Browser wallet", provider: injected });
  }
  window.addEventListener("eip6963:announceProvider", (event) => {
    const wallet = announced((event as CustomEvent<unknown>).detail);
    if (wallet === null || found.has(wallet.id)) return;
    // A wallet that announces itself is also usually window.ethereum. Keep the named entry.
    if (found.get("injected")?.provider === wallet.provider) found.delete("injected");
    found.set(wallet.id, wallet);
    onChange([...found.values()]);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  onChange([...found.values()]);
}
