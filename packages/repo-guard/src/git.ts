import { execFileSync } from "node:child_process";

const MAX_BUFFER = 256 * 1024 * 1024;
const GITLINK_MODE = "160000";
const ZERO_SHA = /^0+$/;

export class NotAGitRepo extends Error {
  override readonly name = "NotAGitRepo";
}

function gitBuffer(args: readonly string[], cwd: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(args: readonly string[], cwd: string): string {
  return gitBuffer(args, cwd).toString("utf8");
}

export function repoRoot(cwd: string): string {
  try {
    return gitText(["rev-parse", "--show-toplevel"], cwd).trim();
  } catch {
    throw new NotAGitRepo(`${cwd} is not inside a git work tree`);
  }
}

// Added, copied or modified paths in the index, without submodule gitlinks.
export function stagedPaths(root: string): string[] {
  const parts = gitText(
    ["diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=ACM"],
    root,
  ).split("\0");
  const paths: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] ?? "";
    const path = parts[i + 1] ?? "";
    const newMode = meta.slice(1).split(" ")[1];
    if (newMode !== GITLINK_MODE && path !== "") paths.push(path);
  }
  return paths;
}

export function stagedContent(root: string, path: string): Buffer {
  return gitBuffer(["show", `:${path}`], root);
}

// Every tracked path except submodule gitlinks.
export function trackedPaths(root: string): string[] {
  const paths: string[] = [];
  for (const entry of gitText(["ls-files", "-s", "-z"], root).split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const mode = entry.slice(0, entry.indexOf(" "));
    if (mode !== GITLINK_MODE) paths.push(entry.slice(tab + 1));
  }
  return paths;
}

export function hasCommits(root: string): boolean {
  try {
    gitBuffer(["rev-parse", "--verify", "--quiet", "HEAD"], root);
    return true;
  } catch {
    return false;
  }
}

export interface CommitMessage {
  readonly sha: string;
  readonly message: string;
}

export function commitMessages(root: string, revArgs: readonly string[]): CommitMessage[] {
  return gitText(["log", "--format=%h%x1f%B%x00", ...revArgs], root)
    .split("\0")
    .map((record) => record.replace(/^\s+/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const cut = record.indexOf("\x1f");
      return { sha: record.slice(0, cut), message: record.slice(cut + 1).trim() };
    });
}

export interface HistoryBlob {
  readonly id: string;
  readonly path: string;
  readonly content: Buffer;
}

// The first path each object appears at in `git rev-list --objects` output. Commits have no path.
export function firstPaths(revListObjects: string): Map<string, string> {
  const paths = new Map<string, string>();
  for (const line of revListObjects.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const id = line.slice(0, space);
    if (!paths.has(id)) paths.set(id, line.slice(space + 1));
  }
  return paths;
}

// The blob IDs in `git cat-file --batch-check="%(objectname) %(objecttype)"` output.
export function blobIds(batchCheck: string): string[] {
  return batchCheck
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([, kind]) => kind === "blob")
    .map(([id = ""]) => id);
}

// Every file version any commit on any ref has held, once per blob, under the first path it was
// seen at. Commits reach blobs through trees, and submodule gitlinks aren't followed.
export function historyBlobs(root: string): HistoryBlob[] {
  const paths = firstPaths(gitText(["rev-list", "--all", "--objects"], root));
  const kinds = execFileSync("git", ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    cwd: root,
    input: `${[...paths.keys()].join("\n")}\n`,
    maxBuffer: MAX_BUFFER,
  }).toString("utf8");
  return blobIds(kinds).map((id) => ({
    id,
    path: paths.get(id) ?? "",
    content: gitBuffer(["cat-file", "blob", id], root),
  }));
}

export function branchNames(root: string): string[] {
  return gitText(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], root)
    .split("\n")
    .filter((name) => name !== "");
}

export interface PushUpdate {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

// git feeds pre-push one line per ref: "<local ref> <local sha> <remote ref> <remote sha>".
export function parsePushUpdates(stdin: string): PushUpdate[] {
  return stdin
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 4)
    .map(([localRef = "", localSha = "", remoteRef = "", remoteSha = ""]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }));
}

export function isDeletion(update: PushUpdate): boolean {
  return ZERO_SHA.test(update.localSha);
}

// Commits the push would publish. A new remote branch sends everything no remote ref has yet.
export function pushedRevArgs(update: PushUpdate): string[] {
  if (ZERO_SHA.test(update.remoteSha)) return [update.localSha, "--not", "--remotes"];
  return [`${update.remoteSha}..${update.localSha}`];
}

export function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
