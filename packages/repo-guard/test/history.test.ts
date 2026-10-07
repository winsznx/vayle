import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blobIds, firstPaths } from "../src/git.ts";

describe("firstPaths", () => {
  it("keeps the first path each object appears at and skips commits", () => {
    // #given: rev-list --objects lists commits bare, then trees and blobs with their paths
    const output = [
      "c0ffee01",
      "aaaa1111 ",
      "bbbb2222 docs/a.md",
      "c0ffee02",
      "bbbb2222 renamed/a.md",
      "cccc3333 b.md",
    ].join("\n");
    // #when
    const paths = firstPaths(output);
    // #then
    assert.deepEqual(
      [...paths.entries()],
      [
        ["aaaa1111", ""],
        ["bbbb2222", "docs/a.md"],
        ["cccc3333", "b.md"],
      ],
    );
  });
});

describe("blobIds", () => {
  it("keeps blobs and drops trees, commits and missing objects", () => {
    // #given
    const output = ["aaaa1111 tree", "bbbb2222 blob", "dddd4444 missing", "cccc3333 blob", ""].join(
      "\n",
    );
    // #when / #then
    assert.deepEqual(blobIds(output), ["bbbb2222", "cccc3333"]);
  });
});
