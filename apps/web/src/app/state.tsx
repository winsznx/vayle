import { robinhoodChain } from "@vayle/chain-facts/chain";
import { withGasMargin, type Call } from "@vayle/market";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import type { Chain, PublicClient } from "viem";
import { publicClientOf } from "./chain.ts";
import { describeFailure, reverted } from "./failures.ts";
import type { AppConfig } from "./config.ts";
import { useDisclosures, type DisclosuresState } from "./useDisclosures.ts";
import { useMarket, type MarketView } from "./useMarket.ts";
import { useMarketHistory, type MarketHistory } from "./useMarketHistory.ts";
import { useWallet, type Wallet } from "./wallet.ts";

// Everything the app's routes share: one read of the market, the holder's history, the wallet, and
// the transaction in flight. Every route reads the same poll instead of starting its own.

// A transaction's life as the holder sees it: waiting for their signature, then for the chain, then
// done or failed. The hash is known from the moment the wallet sends it.
export type TxState =
  | { readonly status: "idle" }
  | {
      readonly status: "signing";
      readonly label: string;
      readonly step: number;
      readonly steps: number;
    }
  | {
      readonly status: "confirming";
      readonly label: string;
      readonly hash: string;
      readonly step: number;
      readonly steps: number;
    }
  | { readonly status: "done"; readonly label: string; readonly hash: string | null }
  | { readonly status: "failed"; readonly label: string; readonly reason: string };

export type Run = (label: string, calls: readonly Call[]) => Promise<boolean>;

export interface Placement {
  readonly open: boolean;
  // Why the ticket can't place an order right now, in the holder's words.
  readonly reason: string;
}

export interface AppState {
  readonly config: AppConfig;
  readonly client: PublicClient;
  readonly chain: Chain;
  readonly wallet: Wallet;
  // Connected, and on Robinhood Chain.
  readonly onChain: boolean;
  readonly view: MarketView | null;
  readonly readError: string | null;
  readonly history: MarketHistory;
  readonly disclosures: DisclosuresState;
  readonly tx: TxState;
  readonly busy: boolean;
  readonly run: Run;
  readonly placement: Placement;
}

const AppContext = createContext<AppState | null>(null);

export class OutsideAppProvider extends Error {
  override readonly name = "OutsideAppProvider";
}

export function useApp(): AppState {
  const state = use(AppContext);
  if (state === null) throw new OutsideAppProvider("useApp needs an AppProvider above it.");
  return state;
}

function placementOf(
  config: AppConfig,
  disclosures: DisclosuresState,
  wallet: Wallet,
  onChain: boolean,
): Placement {
  if (!config.placement) {
    return {
      open: false,
      reason:
        "New orders aren't open yet. Existing orders can still be settled, stopped and withdrawn.",
    };
  }
  if (disclosures.status !== "approved") {
    return { open: false, reason: "Trading opens once the disclosures are final." };
  }
  if (wallet.address === null)
    return { open: false, reason: "Connect a wallet to place an order." };
  if (!onChain) {
    return { open: false, reason: "Switch your wallet to Robinhood Chain to place an order." };
  }
  return { open: true, reason: "" };
}

export function AppProvider({
  config,
  children,
}: {
  readonly config: AppConfig;
  readonly children: ReactNode;
}) {
  const client = useMemo(() => publicClientOf(config), [config]);
  const wallet = useWallet(robinhoodChain);
  const [version, setVersion] = useState(0);
  const [tx, setTx] = useState<TxState>({ status: "idle" });
  const { view, error } = useMarket(client, config, wallet.address, version);
  const history = useMarketHistory(client, config, wallet.address, version);
  const disclosures = useDisclosures();
  const onChain = wallet.address !== null && wallet.chainId === config.chainId;

  // Sends the calls one after another, each after the last confirms, then refreshes what's shown.
  // A transaction counts only if its receipt says it succeeded.
  const run: Run = async (label, calls) => {
    const account = wallet.address;
    if (account === null) return false;
    let last: string | null = null;
    try {
      for (const [i, call] of calls.entries()) {
        setTx({ status: "signing", label, step: i + 1, steps: calls.length });
        const estimate = await client.estimateGas({ account, to: call.to, data: call.data });
        const hash = await wallet.send(call, withGasMargin(estimate));
        last = hash;
        setTx({ status: "confirming", label, hash, step: i + 1, steps: calls.length });
        const receipt = await client.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw reverted(hash);
      }
      setTx({ status: "done", label, hash: last });
      return true;
    } catch (failure) {
      setTx({ status: "failed", label, reason: describeFailure(failure) });
      return false;
    } finally {
      setVersion((v) => v + 1);
    }
  };

  const state: AppState = {
    config,
    client,
    chain: robinhoodChain,
    wallet,
    onChain,
    view,
    readError: error,
    history,
    disclosures,
    tx,
    busy: tx.status === "signing" || tx.status === "confirming",
    run,
    placement: placementOf(config, disclosures, wallet, onChain),
  };
  return <AppContext value={state}>{children}</AppContext>;
}
