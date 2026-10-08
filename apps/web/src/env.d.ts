/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_MARKET?: string;
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_PLACEMENT?: string;
  readonly VITE_MARKET_DEPLOY_BLOCK?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_MAKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
