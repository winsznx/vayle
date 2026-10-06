import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DOCS_DIR } from "../src/config.ts";

// These tests run the real hook scripts against scratch repositories. Nothing here creates a commit:
// each hook is invoked the way git invokes it.
const HOOKS = resolve(fileURLToPath(new URL("../../../.githooks", import.meta.url)));
const CLI = join(HOOKS, "..", "packages", "repo-guard", "src", "cli.ts");

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function scratchRepo(withLists: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "repo-guard-hooks-"));
  git(root, "init", "-q");
  if (withLists) {
    mkdirSync(join(root, DOCS_DIR));
    writeFileSync(join(root, DOCS_DIR, "denylist.txt"), "Zorblax  # test source\n");
    writeFileSync(join(root, DOCS_DIR, "denylist-common.txt"), "Glimmer\n");
  }
  return root;
}

function stage(root: string, path: string, content: string | Buffer): void {
  writeFileSync(join(root, path), content);
  git(root, "add", "--", path);
}

function hook(
  root: string,
  name: string,
  args: string[] = [],
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(join(HOOKS, name), args, { cwd: root, encoding: "utf8", input });
}

function ci(root: string, env: Record<string, string>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [CLI, "ci"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
}

describe("pre-commit hook", () => {
  it("passes clean staged files", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "a.md", "nothing to see\n");
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.equal(result.status, 0, result.stderr);
  });

  it("blocks a fail-list name and reports the file, line and term", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "a.md", "line one\nmentions zorblax\n");
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.deepEqual(
      [result.status, /FAIL {2}a\.md:2 {2}matches "Zorblax"/.test(result.stderr)],
      [1, true],
    );
  });

  it("warns on a warn-list name without blocking", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "a.md", "Glimmer\n");
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.deepEqual([result.status, /WARN {2}a\.md:1/.test(result.stderr)], [0, true]);
  });

  it("blocks a reference to the private docs folder even when the lists are absent", () => {
    // #given
    const root = scratchRepo(false);
    stage(root, "a.md", `see ${DOCS_DIR}/plan.md\n`);
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.deepEqual(
      [
        result.status,
        /PATH {2}a\.md:1/.test(result.stderr),
        /name checks are skipped/.test(result.stderr),
      ],
      [1, true, true],
    );
  });

  it("blocks an env template that holds a value", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, ".env.example", "# rpc\nRPC_URL=https://example.invalid\n");
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.deepEqual([result.status, /ENV {3}\.env\.example:2/.test(result.stderr)], [1, true]);
  });

  it("checks staged content rather than the working tree", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "a.md", "Zorblax\n");
    writeFileSync(join(root, "a.md"), "clean now but not staged\n");
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.equal(result.status, 1);
  });

  it("skips names in the lockfile", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "pnpm-lock.yaml", "integrity: sha512-zorblaxAAAA==\n");
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.equal(result.status, 0, result.stderr);
  });

  it("still runs the path check in the lockfile", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "pnpm-lock.yaml", `link: ${DOCS_DIR}/x\n`);
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.equal(result.status, 1);
  });

  it("reports binary files instead of scanning them", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "img.bin", Buffer.from([0x00, 0x5a, 0x6f, 0x72]));
    // #when
    const result = hook(root, "pre-commit");
    // #then
    assert.deepEqual(
      [result.status, /img\.bin is binary and was not scanned/.test(result.stderr)],
      [0, true],
    );
  });
});

describe("commit-msg hook", () => {
  it("ignores git comment lines", () => {
    // #given
    const root = scratchRepo(true);
    const file = join(root, "MSG");
    writeFileSync(file, "Add notes\n# Zorblax in a comment line is dropped by git\n");
    // #when
    const result = hook(root, "commit-msg", [file]);
    // #then
    assert.equal(result.status, 0, result.stderr);
  });

  it("blocks a fail-list name in the message", () => {
    // #given
    const root = scratchRepo(true);
    const file = join(root, "MSG");
    writeFileSync(file, "Port the Zorblax flow\n");
    // #when
    const result = hook(root, "commit-msg", [file]);
    // #then
    assert.deepEqual([result.status, /commit message:1/.test(result.stderr)], [1, true]);
  });
});

describe("pre-push hook", () => {
  it("skips ref deletions", () => {
    // #given
    const root = scratchRepo(true);
    const input = `(delete) ${"0".repeat(40)} refs/heads/zorblax-old ${"b".repeat(40)}\n`;
    // #when
    const result = hook(root, "pre-push", ["origin", "https://example.invalid/repo"], input);
    // #then
    assert.equal(result.status, 0, result.stderr);
  });
});

describe("ci mode", () => {
  it("fails closed with a named error when the list variables are missing", () => {
    // #given
    const root = scratchRepo(true);
    // #when
    const result = ci(root, {});
    // #then
    assert.deepEqual([result.status, /MissingNameListSecret/.test(result.stderr)], [2, true]);
  });

  it("masks every term before reporting hits by list position", () => {
    // #given
    const root = scratchRepo(true);
    stage(root, "a.md", "Zorblax\n");
    const env = {
      VAYLE_DENYLIST: join(root, DOCS_DIR, "denylist.txt"),
      VAYLE_DENYLIST_COMMON: join(root, DOCS_DIR, "denylist-common.txt"),
    };
    // #when
    const result = ci(root, env);
    // #then
    assert.deepEqual(
      [
        result.status,
        result.stdout.includes("::add-mask::Zorblax"),
        result.stdout.includes("::add-mask::Glimmer"),
        result.stderr.includes("fail list term #1"),
        result.stderr.includes("Zorblax"),
      ],
      [1, true, true, true, false],
    );
  });
});
