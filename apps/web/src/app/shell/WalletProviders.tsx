import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { WagmiProvider, type Config } from "wagmi";
import { currentTheme, subscribeTheme } from "../../ui/theme.ts";
import facts from "../../../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { DARK_THEME, LIGHT_THEME } from "../walletConfig.ts";

// The modal's "Learn more" goes to Robinhood Chain's own page on adding the network to a wallet.
const ADD_THE_NETWORK = facts.chain.sources[0] ?? "https://docs.robinhood.com/chain/connecting";

// wagmi, TanStack Query and RainbowKit, around the app. Only wagmi's own hooks use the query
// client, and the app's reads keep their own 15-second poll, so nothing refetches on focus.
export function WalletProviders({
  wagmiConfig,
  children,
}: {
  readonly wagmiConfig: Config;
  readonly children: ReactNode;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }),
  );
  const theme = useSyncExternalStore(subscribeTheme, currentTheme);
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={theme === "dark" ? DARK_THEME : LIGHT_THEME}
          appInfo={{ appName: "Vayle", learnMoreUrl: ADD_THE_NETWORK }}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
