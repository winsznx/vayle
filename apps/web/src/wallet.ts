import type { Call } from "@vayle/market";
import {
  createWalletClient,
  custom,
  getAddress,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
} from "viem";

// Wallets announce themselves (EIP-6963), and the connected account can change from outside the
// app, so both live in small stores React reads with useSyncExternalStore.

export interface WalletProvider {
  readonly info: { readonly uuid: string; readonly name: string; readonly icon: string };
  readonly provider: EIP1193Provider;
}

export interface Connection {
  readonly wallet: WalletProvider;
  readonly address: Address;
  readonly chainId: number;
}

type Listener = () => void;

function isWalletProvider(value: unknown): value is WalletProvider {
  if (typeof value !== "object" || value === null) return false;
  const { info, provider } = value as { info?: unknown; provider?: unknown };
  return (
    typeof info === "object" &&
    info !== null &&
    typeof (info as { uuid?: unknown }).uuid === "string" &&
    typeof (info as { name?: unknown }).name === "string" &&
    typeof provider === "object" &&
    provider !== null &&
    typeof (provider as { request?: unknown }).request === "function"
  );
}

const announced = new Map<string, WalletProvider>();
let walletsSnapshot: readonly WalletProvider[] = [];

export function subscribeWallets(onChange: Listener): () => void {
  const onAnnounce = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!isWalletProvider(detail) || announced.has(detail.info.uuid)) return;
    announced.set(detail.info.uuid, detail);
    walletsSnapshot = [...announced.values()];
    onChange();
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  };
}

export function walletsNow(): readonly WalletProvider[] {
  return walletsSnapshot;
}

let connection: Connection | null = null;
const connectionListeners = new Set<Listener>();

function setConnection(next: Connection | null): void {
  connection = next;
  for (const listener of connectionListeners) listener();
}

export function subscribeConnection(onChange: Listener): () => void {
  connectionListeners.add(onChange);
  return () => connectionListeners.delete(onChange);
}

export function connectionNow(): Connection | null {
  return connection;
}

// The listeners on the connected wallet, removed when it disconnects or another one connects.
let detach: (() => void) | null = null;

export async function connect(wallet: WalletProvider): Promise<void> {
  const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
  const chainId = await wallet.provider.request({ method: "eth_chainId" });
  const first = accounts[0];
  if (first === undefined) throw new Error("The wallet didn't share an account.");
  detach?.();
  const onAccounts = (next: readonly Address[]): void => {
    const account = next[0];
    const current = connectionNow();
    setConnection(
      account === undefined || current === null
        ? null
        : { ...current, address: getAddress(account) },
    );
  };
  const onChain = (next: string): void => {
    const current = connectionNow();
    if (current !== null) setConnection({ ...current, chainId: Number(next) });
  };
  wallet.provider.on("accountsChanged", onAccounts);
  wallet.provider.on("chainChanged", onChain);
  detach = () => {
    wallet.provider.removeListener("accountsChanged", onAccounts);
    wallet.provider.removeListener("chainChanged", onChain);
  };
  setConnection({ wallet, address: getAddress(first), chainId: Number(chainId) });
}

export function disconnect(): void {
  detach?.();
  detach = null;
  setConnection(null);
}

export async function switchTo(wallet: WalletProvider, chain: Chain): Promise<void> {
  await wallet.provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: numberToHex(chain.id) }],
  });
}

// Sends one call from the connected account and returns its hash. The wallet shows it first.
export async function send(current: Connection, chain: Chain, call: Call): Promise<Hash> {
  const client = createWalletClient({
    account: current.address,
    chain,
    transport: custom(current.wallet.provider),
  });
  return client.sendTransaction({ to: call.to, data: call.data, account: current.address, chain });
}
