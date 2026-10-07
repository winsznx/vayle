import { connectorsForWallets, darkTheme, lightTheme, type Wallet } from "@rainbow-me/rainbowkit";
import { injectedWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import type { Chain } from "viem";
import { createConfig, createStorage, http, type Config } from "wagmi";
import type { AppConfig } from "./config.ts";

// The wallet layer: wagmi for the connection, RainbowKit for the modal. Installed browser wallets
// announce themselves (EIP-6963) and list by name. WalletConnect, for phones and for wallets that
// only live on a phone, joins when the build has a project ID. wagmi's only transport is the app's
// own RPC, and wallets that add the chain get robinhoodChain's public RPC, never this one.

// localStorage throws when a browser blocks site data, and wagmi's default storage only guards
// writes. Without storage, a wallet just doesn't reconnect on the next visit.
const guardedStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      console.info("This browser won't remember the wallet between visits.", error);
    }
  },
  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      console.info("This browser won't remember the wallet between visits.", error);
    }
  },
};

// Phones, by the same signs RainbowKit uses to switch to its mobile list.
function onPhone(): boolean {
  const agent = navigator.userAgent;
  return (
    /Android|iPhone|iPod|iPad/i.test(agent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// The wallet a page's own provider belongs to. On a computer, installed wallets already list by
// name, so this row would repeat one of them. On a phone it's how a wallet's in-app browser
// connects, since RainbowKit's phone list leaves announced wallets out.
const browserWallet = (): Wallet => ({ ...injectedWallet(), hidden: () => !onPhone() });

export function walletConfigOf(config: AppConfig, chain: Chain): Config {
  const projectId = config.walletConnectProjectId;
  const connectors = connectorsForWallets(
    [
      {
        groupName: "Wallets",
        wallets: projectId === null ? [browserWallet] : [browserWallet, walletConnectWallet],
      },
    ],
    { appName: "Vayle", projectId: projectId ?? "" },
  );
  return createConfig({
    chains: [chain],
    transports: { [chain.id]: http(config.rpcUrl) },
    connectors,
    multiInjectedProviderDiscovery: true,
    storage: createStorage({ storage: guardedStorage }),
  });
}

// The modal in Vayle's own type and colors. The colors point at the design tokens, so the modal
// follows the theme toggle with the rest of the page.
const FONT =
  '"Plus Jakarta Sans Variable", "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif';

type ThemeVars = ReturnType<typeof lightTheme>;

function vayle(base: ThemeVars): ThemeVars {
  return {
    ...base,
    colors: {
      ...base.colors,
      accentColor: "var(--brand)",
      accentColorForeground: "var(--on-brand)",
      modalBackground: "var(--sheet)",
      modalBorder: "var(--hairline)",
      modalText: "var(--ink)",
      modalTextSecondary: "var(--muted)",
      modalTextDim: "var(--muted)",
      generalBorder: "var(--hairline)",
      generalBorderDim: "var(--hairline)",
      menuItemBackground: "var(--sunken)",
      closeButtonBackground: "var(--sunken)",
      closeButton: "var(--muted)",
      error: "var(--problem)",
    },
    fonts: { body: FONT },
  };
}

export const LIGHT_THEME = vayle(lightTheme({ borderRadius: "large", overlayBlur: "small" }));
export const DARK_THEME = vayle(darkTheme({ borderRadius: "large", overlayBlur: "small" }));
