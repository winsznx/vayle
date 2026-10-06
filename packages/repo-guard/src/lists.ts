import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DOCS_DIR,
  FAIL_LIST_ENV,
  FAIL_LIST_FILE,
  WARN_LIST_ENV,
  WARN_LIST_FILE,
} from "./config.ts";
import { termPattern } from "./match.ts";

export interface NameTerm {
  readonly term: string;
  // 1-based position within its list. CI output shows this instead of the term.
  readonly index: number;
  readonly pattern: RegExp;
}

export interface NameLists {
  readonly fail: readonly NameTerm[];
  readonly warn: readonly NameTerm[];
  readonly notices: readonly string[];
}

export class MalformedNameList extends Error {
  override readonly name = "MalformedNameList";
}

export class MissingNameListSecret extends Error {
  override readonly name = "MissingNameListSecret";
}

const MIN_TERM_LENGTH = 2;

// One term per line. Blank lines and lines starting with "#" are skipped. Text after " #" is the
// term's source note and is ignored.
export function parseNameList(text: string, caseSensitive: boolean, source: string): NameTerm[] {
  const terms: NameTerm[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const noteStart = line.indexOf(" #");
    const term = (noteStart === -1 ? line : line.slice(0, noteStart)).trim();
    if (term.length < MIN_TERM_LENGTH) {
      throw new MalformedNameList(
        `${source}:${i + 1}: a term needs at least ${MIN_TERM_LENGTH} characters`,
      );
    }
    terms.push({ term, index: terms.length + 1, pattern: termPattern(term, caseSensitive) });
  });
  return terms;
}

interface ListSpec {
  readonly label: string;
  readonly envVar: string;
  readonly defaultPath: string;
  readonly caseSensitive: boolean;
}

function loadOne(
  spec: ListSpec,
  env: Readonly<Record<string, string | undefined>>,
  required: boolean,
  notices: string[],
): NameTerm[] {
  const fromEnv = env[spec.envVar];
  if (required && (fromEnv === undefined || fromEnv === "")) {
    throw new MissingNameListSecret(`${spec.envVar} must name the ${spec.label} file`);
  }
  const path = fromEnv !== undefined && fromEnv !== "" ? fromEnv : spec.defaultPath;
  if (!existsSync(path)) {
    if (required) throw new MissingNameListSecret(`${spec.label} file not found`);
    notices.push(`${spec.label} not found, so its name checks are skipped`);
    return [];
  }
  const terms = parseNameList(readFileSync(path, "utf8"), spec.caseSensitive, spec.label);
  if (required && terms.length === 0) {
    throw new MissingNameListSecret(`${spec.label} is empty`);
  }
  return terms;
}

// In CI both lists are required and come from files named by environment variables. Locally a
// missing list only skips its own name checks.
export function loadNameLists(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  required: boolean,
): NameLists {
  const notices: string[] = [];
  const fail = loadOne(
    {
      label: "fail list",
      envVar: FAIL_LIST_ENV,
      defaultPath: join(root, DOCS_DIR, FAIL_LIST_FILE),
      caseSensitive: false,
    },
    env,
    required,
    notices,
  );
  const warn = loadOne(
    {
      label: "warn list",
      envVar: WARN_LIST_ENV,
      defaultPath: join(root, DOCS_DIR, WARN_LIST_FILE),
      caseSensitive: true,
    },
    env,
    required,
    notices,
  );
  return { fail, warn, notices };
}
