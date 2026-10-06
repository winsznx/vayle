// Private working docs live in this folder at the repo root. The folder is gitignored, and committed
// files must not point into it.
export const DOCS_DIR = "internal";

export const FAIL_LIST_FILE = "denylist.txt";
export const WARN_LIST_FILE = "denylist-common.txt";

export const FAIL_LIST_ENV = "VAYLE_DENYLIST";
export const WARN_LIST_ENV = "VAYLE_DENYLIST_COMMON";

// Path segments that only ever hold generated output or installed dependencies.
export const GENERATED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  ".next",
  ".open-next",
  ".wrangler",
  ".turbo",
  "coverage",
]);

// Foundry writes compiler output and its cache here.
export const GENERATED_PREFIXES: readonly string[] = ["contracts/out/", "contracts/cache/"];

// Lockfile integrity hashes are base64, so short terms can match them by chance.
export const LOCKFILES: ReadonlySet<string> = new Set(["pnpm-lock.yaml"]);

export const ENV_TEMPLATE = ".env.example";
