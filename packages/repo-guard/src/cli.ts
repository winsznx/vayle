import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  branchName,
  commitMessages,
  hasCommits,
  isDeletion,
  parsePushUpdates,
  pushedRevArgs,
  repoRoot,
  stagedContent,
  stagedPaths,
  trackedPaths,
  type CommitMessage,
  type PushUpdate,
} from "./git.ts";
import { loadNameLists, type NameLists } from "./lists.ts";
import { summarize } from "./report.ts";
import { isBinary, scanFile, scanText, type Finding } from "./scan.ts";

const USAGE = `usage: repo-guard <mode>
  staged          scan staged files (pre-commit)
  message <file>  scan a commit message file (commit-msg)
  push            scan branch names and outgoing commit messages from stdin (pre-push)
  tree            scan every tracked file with the local lists
  ci              scan tracked files, all commit messages, the branch and PR text, with masked output`;

export interface Io {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readStdin: () => string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

interface Collected {
  readonly findings: Finding[];
  readonly skippedBinaries: string[];
}

const decoder = new TextDecoder("utf-8");

function scanContents(files: Iterable<readonly [string, Uint8Array]>, lists: NameLists): Collected {
  const findings: Finding[] = [];
  const skippedBinaries: string[] = [];
  for (const [path, content] of files) {
    if (isBinary(content)) {
      skippedBinaries.push(path);
      continue;
    }
    findings.push(...scanFile(path, decoder.decode(content), { lists, scanNames: true }));
  }
  return { findings, skippedBinaries };
}

function* stagedFiles(root: string): Generator<readonly [string, Uint8Array]> {
  for (const path of stagedPaths(root)) yield [path, stagedContent(root, path)];
}

function* worktreeFiles(root: string): Generator<readonly [string, Uint8Array]> {
  for (const path of trackedPaths(root)) {
    const full = join(root, path);
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    yield [path, stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full)];
  }
}

function scanMessage(text: string, location: string, lists: NameLists): Finding[] {
  return scanText(text, location, { lists, scanNames: true });
}

// git keeps comment lines in the message file until after commit-msg runs.
function stripCommentLines(message: string): string {
  return message
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("#"))
    .join("\n");
}

export function scanPush(
  updates: readonly PushUpdate[],
  lists: NameLists,
  messagesFor: (update: PushUpdate) => readonly CommitMessage[],
): Finding[] {
  const findings: Finding[] = [];
  for (const update of updates) {
    if (isDeletion(update)) continue;
    findings.push(...scanMessage(branchName(update.localRef), "local branch name", lists));
    findings.push(...scanMessage(branchName(update.remoteRef), "remote branch name", lists));
    for (const { sha, message } of messagesFor(update)) {
      findings.push(...scanMessage(message, `commit ${sha} message`, lists));
    }
  }
  return findings;
}

function scanCi(root: string, io: Io, lists: NameLists): Collected {
  const { findings, skippedBinaries } = scanContents(worktreeFiles(root), lists);
  const history = hasCommits(root) ? commitMessages(root, ["HEAD"]) : [];
  for (const { sha, message } of history) {
    findings.push(...scanMessage(message, `commit ${sha} message`, lists));
  }
  const extra: ReadonlyArray<readonly [string, string | undefined]> = [
    ["branch name", io.env["VAYLE_CI_BRANCH"]],
    ["pull request title", io.env["VAYLE_CI_PR_TITLE"]],
    ["pull request body", io.env["VAYLE_CI_PR_BODY"]],
  ];
  for (const [location, text] of extra) {
    if (text !== undefined && text !== "") findings.push(...scanMessage(text, location, lists));
  }
  return { findings, skippedBinaries };
}

export function run(args: readonly string[], io: Io): number {
  const [mode, arg] = args;
  const masked = mode === "ci";
  try {
    const root = repoRoot(io.cwd);
    const lists = loadNameLists(root, io.env, masked);
    if (masked) {
      // Registered before any scan output, so a term never appears in public CI logs.
      for (const term of [...lists.fail, ...lists.warn]) io.out(`::add-mask::${term.term}`);
    }
    let collected: Collected;
    switch (mode) {
      case "staged":
        collected = scanContents(stagedFiles(root), lists);
        break;
      case "tree":
        collected = scanContents(worktreeFiles(root), lists);
        break;
      case "message": {
        if (arg === undefined) {
          io.err(USAGE);
          return 2;
        }
        const message = stripCommentLines(readFileSync(arg, "utf8"));
        collected = {
          findings: scanMessage(message, "commit message", lists),
          skippedBinaries: [],
        };
        break;
      }
      case "push": {
        const updates = parsePushUpdates(io.readStdin());
        const findings = scanPush(updates, lists, (update) =>
          commitMessages(root, pushedRevArgs(update)),
        );
        collected = { findings, skippedBinaries: [] };
        break;
      }
      case "ci":
        collected = scanCi(root, io, lists);
        break;
      default:
        io.err(USAGE);
        return 2;
    }
    const summary = summarize(collected.findings, lists.notices, collected.skippedBinaries, {
      masked,
    });
    for (const line of summary.lines) io.err(line);
    return summary.blocking > 0 ? 1 : 0;
  } catch (error) {
    const named = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    io.err(`repo-guard: ${named}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    readStdin: () => readFileSync(0, "utf8"),
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}
