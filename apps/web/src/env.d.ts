/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_MARKET?: string;
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_PLACEMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
