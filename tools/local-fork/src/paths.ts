import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

// Everything the fork writes lives in deployments/fork/, which git ignores.
export const FORK_DIR = `${root}deployments/fork`;
export const ACCOUNTS_FILE = `${FORK_DIR}/accounts.json`;
export const BOUNDARIES_FILE = `${FORK_DIR}/calendar-boundaries.json`;
export const RECORD_FILE = `${FORK_DIR}/vayle.json`;
export const FEED_WRITES_FILE = `${FORK_DIR}/feed-writes.jsonl`;
export const ANVIL_LOG = `${FORK_DIR}/anvil.log`;
export const CONTRACTS_DIR = `${root}contracts`;
// Vite reads it in `--mode fork`. The .env* rule in .gitignore covers it.
export const WEB_ENV_FILE = `${root}apps/web/.env.fork.local`;
