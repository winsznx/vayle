import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanPush } from "../src/cli.ts";
import {
  branchName,
  isDeletion,
  parsePushUpdates,
  pushedRevArgs,
  type CommitMessage,
  type PushUpdate,
} from "../src/git.ts";
import { parseNameList, type NameLists } from "../src/lists.ts";

const ZERO = "0".repeat(40);
const LOCAL = "a".repeat(40);
const REMOTE = "b".repeat(40);

const lists: NameLists = { fail: parseNameList("Zorblax\n", false, "fail"), warn: [], notices: [] };

function update(localRef: string, localSha: string, remoteSha: string): PushUpdate {
  return {
    localRef,
    localSha,
    remoteRef: localRef === "(delete)" ? "refs/heads/x" : localRef,
    remoteSha,
  };
}

function messagesBySha(table: Record<string, CommitMessage[]>) {
  return (u: PushUpdate): CommitMessage[] => table[u.localSha] ?? [];
}

describe("parsePushUpdates", () => {
  it("parses one update per line and ignores blank or short lines", () => {
    // #given
    const stdin = `refs/heads/main ${LOCAL} refs/heads/main ${REMOTE}\n\nbad line\n`;
    // #when
    const updates = parsePushUpdates(stdin);
    // #then
    assert.deepEqual(updates, [
      {
        localRef: "refs/heads/main",
        localSha: LOCAL,
        remoteRef: "refs/heads/main",
        remoteSha: REMOTE,
      },
    ]);
  });
});

describe("pushedRevArgs", () => {
  it("sends everything no remote has yet for a new branch and the range for an update", () => {
    // #given
    const created = update("refs/heads/x", LOCAL, ZERO);
    const updated = update("refs/heads/x", LOCAL, REMOTE);
    // #when
    const args = [pushedRevArgs(created), pushedRevArgs(updated)];
    // #then
    assert.deepEqual(args, [[LOCAL, "--not", "--remotes"], [`${REMOTE}..${LOCAL}`]]);
  });
});

describe("isDeletion and branchName", () => {
  it("recognizes a deletion and strips the heads prefix", () => {
    // #given
    const deletion = update("(delete)", ZERO, REMOTE);
    // #when
    const results = [isDeletion(deletion), branchName("refs/heads/feature/x"), branchName("HEAD")];
    // #then
    assert.deepEqual(results, [true, "feature/x", "HEAD"]);
  });
});

describe("scanPush", () => {
  it("flags a fail-list name in the branch and in an outgoing commit message", () => {
    // #given
    const updates = [update("refs/heads/zorblax-port", LOCAL, ZERO)];
    const messages = messagesBySha({ [LOCAL]: [{ sha: "abc1234", message: "Add Zorblax notes" }] });
    // #when
    const findings = scanPush(updates, lists, messages);
    // #then
    assert.deepEqual(
      findings.map((f) => f.location),
      ["local branch name", "remote branch name", "commit abc1234 message"],
    );
  });

  it("skips deletions and passes clean pushes", () => {
    // #given
    const updates = [update("(delete)", ZERO, REMOTE), update("refs/heads/main", LOCAL, REMOTE)];
    const messages = messagesBySha({ [LOCAL]: [{ sha: "abc1234", message: "Tidy" }] });
    // #when
    const findings = scanPush(updates, lists, messages);
    // #then
    assert.deepEqual(findings, []);
  });
});
