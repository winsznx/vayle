import type { Finding } from "./scan.ts";

export interface ReportOptions {
  // CI logs are public, so terms are shown by list position instead of by text.
  readonly masked: boolean;
}

function describe(finding: Finding, options: ReportOptions): string {
  const where = `${finding.location}:${finding.line}`;
  switch (finding.kind) {
    case "path":
      return `PATH  ${where}  points into the private docs folder`;
    case "env":
      return `ENV   ${where}  the env template must hold keys only, with no values`;
    case "fail":
    case "warn": {
      const list = finding.kind === "fail" ? "fail list" : "warn list";
      const what = options.masked
        ? `${list} term #${finding.term?.index ?? "?"}`
        : `"${finding.term?.term ?? "?"}" (${list})`;
      return `${finding.kind === "fail" ? "FAIL" : "WARN"}  ${where}  matches ${what}`;
    }
  }
}

export function isBlocking(finding: Finding): boolean {
  return finding.kind !== "warn";
}

export interface Summary {
  readonly lines: string[];
  readonly blocking: number;
}

export function summarize(
  findings: readonly Finding[],
  notices: readonly string[],
  skippedBinaries: readonly string[],
  options: ReportOptions,
): Summary {
  const lines = notices.map((notice) => `note  ${notice}`);
  for (const path of skippedBinaries) lines.push(`note  ${path} is binary and was not scanned`);
  for (const finding of findings) lines.push(describe(finding, options));
  const blocking = findings.filter(isBlocking).length;
  const warnings = findings.length - blocking;
  if (findings.length > 0) {
    lines.push(`repo-guard: ${blocking} blocking, ${warnings} warning`);
  }
  return { lines, blocking };
}
