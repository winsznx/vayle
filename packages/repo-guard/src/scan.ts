import { posix } from "node:path";
import {
  DOCS_DIR,
  ENV_TEMPLATE,
  GENERATED_PREFIXES,
  GENERATED_SEGMENTS,
  LOCKFILES,
} from "./config.ts";
import type { NameLists, NameTerm } from "./lists.ts";
import { PRIVATE_PATH } from "./match.ts";

export type FindingKind = "fail" | "warn" | "path" | "env";

export interface Finding {
  readonly kind: FindingKind;
  readonly location: string;
  readonly line: number;
  readonly term?: NameTerm;
}

// Name checks skip lockfiles and generated output. The private path check never skips.
export function skipsNameScan(path: string): boolean {
  if (LOCKFILES.has(posix.basename(path))) return true;
  if (GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => GENERATED_SEGMENTS.has(segment));
}

export function isBinary(content: Uint8Array): boolean {
  return content.subarray(0, 8000).includes(0);
}

function lineLocator(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function termFindings(
  text: string,
  terms: readonly NameTerm[],
  kind: "fail" | "warn",
  location: string,
  lineAt: (offset: number) => number,
): Finding[] {
  const findings: Finding[] = [];
  for (const term of terms) {
    for (const match of text.matchAll(term.pattern)) {
      findings.push({ kind, location, line: lineAt(match.index), term });
    }
  }
  return findings;
}

export interface ScanOptions {
  readonly lists: NameLists;
  readonly scanNames: boolean;
}

export function scanText(text: string, location: string, options: ScanOptions): Finding[] {
  const lineAt = lineLocator(text);
  const findings: Finding[] = [];
  for (const match of text.matchAll(PRIVATE_PATH)) {
    // The match can begin on the boundary character, which may be the previous line's newline.
    const at = match.index + match[0].indexOf(DOCS_DIR);
    findings.push({ kind: "path", location, line: lineAt(at) });
  }
  if (options.scanNames) {
    findings.push(...termFindings(text, options.lists.fail, "fail", location, lineAt));
    findings.push(...termFindings(text, options.lists.warn, "warn", location, lineAt));
  }
  return findings;
}

// The env template documents keys. Every non-comment line has to be a bare KEY= with no value.
export function scanEnvTemplate(text: string, location: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (!/^[A-Z][A-Z0-9_]*=$/.test(line)) findings.push({ kind: "env", location, line: i + 1 });
  });
  return findings;
}

export function scanFile(path: string, text: string, options: ScanOptions): Finding[] {
  const findings = scanText(text, path, { ...options, scanNames: !skipsNameScan(path) });
  findings.push(...scanText(path, `${path} (file name)`, { ...options, scanNames: true }));
  if (posix.basename(path) === ENV_TEMPLATE) findings.push(...scanEnvTemplate(text, path));
  return findings;
}
