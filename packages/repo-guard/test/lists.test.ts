import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DOCS_DIR, FAIL_LIST_ENV, WARN_LIST_ENV } from "../src/config.ts";
import {
  loadNameLists,
  MalformedNameList,
  MissingNameListSecret,
  parseNameList,
} from "../src/lists.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "repo-guard-lists-"));
}

describe("parseNameList", () => {
  it("reads terms in order and drops comments, blank lines and source notes", () => {
    // #given
    const text = "# header\n\nZorblax  # Doc 12\nAcme Widget  # Doc 40\n  Spaced Term\n";
    // #when
    const terms = parseNameList(text, false, "test");
    // #then
    assert.deepEqual(
      terms.map((t) => [t.term, t.index]),
      [
        ["Zorblax", 1],
        ["Acme Widget", 2],
        ["Spaced Term", 3],
      ],
    );
  });

  it("accepts Windows line endings", () => {
    // #given
    const text = "Zorblax\r\nAcme\r\n";
    // #when
    const terms = parseNameList(text, false, "test");
    // #then
    assert.equal(terms.length, 2);
  });

  it("rejects a one-character term and reports its line", () => {
    // #given
    const text = "Zorblax\nQ\n";
    // #when
    const parse = (): unknown => parseNameList(text, false, "test");
    // #then
    assert.throws(
      parse,
      (error: unknown) => error instanceof MalformedNameList && /test:2/.test(error.message),
    );
  });
});

describe("loadNameLists", () => {
  it("reads both lists from the private docs folder by default", () => {
    // #given
    const root = scratch();
    mkdirSync(join(root, DOCS_DIR));
    writeFileSync(join(root, DOCS_DIR, "denylist.txt"), "Zorblax\n");
    writeFileSync(join(root, DOCS_DIR, "denylist-common.txt"), "Glimmer\n");
    // #when
    const lists = loadNameLists(root, {}, false);
    // #then
    assert.deepEqual(
      [lists.fail.map((t) => t.term), lists.warn.map((t) => t.term), lists.notices],
      [["Zorblax"], ["Glimmer"], []],
    );
  });

  it("skips a missing list locally and leaves a notice for each", () => {
    // #given
    const root = scratch();
    // #when
    const lists = loadNameLists(root, {}, false);
    // #then
    assert.deepEqual([lists.fail.length, lists.warn.length, lists.notices.length], [0, 0, 2]);
  });

  it("prefers list files named by the environment", () => {
    // #given
    const root = scratch();
    writeFileSync(join(root, "a.txt"), "Zorblax\n");
    writeFileSync(join(root, "b.txt"), "Glimmer\n");
    const env = { [FAIL_LIST_ENV]: join(root, "a.txt"), [WARN_LIST_ENV]: join(root, "b.txt") };
    // #when
    const lists = loadNameLists(root, env, true);
    // #then
    assert.deepEqual([lists.fail[0]?.term, lists.warn[0]?.term], ["Zorblax", "Glimmer"]);
  });

  it("fails closed in CI when a list variable is unset, points nowhere or names an empty list", () => {
    // #given
    const root = scratch();
    writeFileSync(join(root, "a.txt"), "Zorblax\n");
    writeFileSync(join(root, "empty.txt"), "# nothing\n");
    const fail = join(root, "a.txt");
    const cases: Record<string, string>[] = [
      {},
      { [FAIL_LIST_ENV]: fail },
      { [FAIL_LIST_ENV]: fail, [WARN_LIST_ENV]: join(root, "nope.txt") },
      { [FAIL_LIST_ENV]: fail, [WARN_LIST_ENV]: join(root, "empty.txt") },
    ];
    // #when
    const outcomes = cases.map((env) => {
      try {
        loadNameLists(root, env, true);
        return "loaded";
      } catch (error) {
        return error instanceof MissingNameListSecret ? "missing" : "other";
      }
    });
    // #then
    assert.deepEqual(outcomes, ["missing", "missing", "missing", "missing"]);
  });
});
