import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCS_DIR } from "../src/config.ts";
import { PRIVATE_PATH, termPattern } from "../src/match.ts";

function hitCounts(pattern: RegExp, texts: readonly string[]): number[] {
  return texts.map((text) => [...text.matchAll(pattern)].length);
}

describe("fail-list term pattern", () => {
  it("matches a standalone term in any casing", () => {
    // #given
    const pattern = termPattern("Zorblax", false);
    const texts = ["Zorblax", "zorblax", "ZORBLAX", "see Zorblax.", "(zorblax)"];
    // #when
    const counts = hitCounts(pattern, texts);
    // #then
    assert.deepEqual(counts, [1, 1, 1, 1, 1]);
  });

  it("matches next to underscores, dots, hyphens and apostrophes", () => {
    // #given
    const pattern = termPattern("Zorblax", false);
    const texts = ["ZORBLAX_URL", "zorblax.io", "pre-zorblax", "Zorblax's"];
    // #when
    const counts = hitCounts(pattern, texts);
    // #then
    assert.deepEqual(counts, [1, 1, 1, 1]);
  });

  it("doesn't match inside a longer word or next to a digit", () => {
    // #given
    const pattern = termPattern("Zorblax", false);
    const texts = ["zorblaxes", "myzorblax", "Zorblax9", "1zorblax"];
    // #when
    const counts = hitCounts(pattern, texts);
    // #then
    assert.deepEqual(counts, [0, 0, 0, 0]);
  });

  it("joins phrase words with spaces, hyphens, underscores or nothing", () => {
    // #given
    const pattern = termPattern("Acme Widget", false);
    const texts = ["acme widget", "AcmeWidget", "acme-widget", "ACME_WIDGET", "acme \t widget"];
    // #when
    const counts = hitCounts(pattern, texts);
    // #then
    assert.deepEqual(counts, [1, 1, 1, 1, 1]);
  });

  it("doesn't match a phrase with other words between or a longer last word", () => {
    // #given
    const pattern = termPattern("Acme Widget", false);
    // #when
    const counts = hitCounts(pattern, ["acme widgets", "acme and widget"]);
    // #then
    assert.deepEqual(counts, [0, 0]);
  });

  it("can't match a letter-led term inside a hex string", () => {
    // #given
    const pattern = termPattern("x40", false);
    // #when
    const counts = hitCounts(pattern, ["0x40ab12", "a x40 b"]);
    // #then
    assert.deepEqual(counts, [0, 1]);
  });

  it("treats regex syntax in a term literally", () => {
    // #given
    const pattern = termPattern("ex.io", false);
    // #when
    const counts = hitCounts(pattern, ["ex.io", "exaio"]);
    // #then
    assert.deepEqual(counts, [1, 0]);
  });

  it("keeps curly and straight apostrophes distinct", () => {
    // #given
    const straight = termPattern("Quixo's Fair", false);
    const curly = termPattern("Quixo’s Fair", false);
    // #when
    const counts = [
      ...hitCounts(straight, ["Quixo’s Fair"]),
      ...hitCounts(curly, ["Quixo’s Fair"]),
    ];
    // #then
    assert.deepEqual(counts, [0, 1]);
  });
});

describe("warn-list term pattern", () => {
  it("matches only the exact casing", () => {
    // #given
    const pattern = termPattern("Glimmer", true);
    // #when
    const counts = hitCounts(pattern, ["Glimmer", "glimmer", "GLIMMER"]);
    // #then
    assert.deepEqual(counts, [1, 0, 0]);
  });

  it("uses the same boundaries as the fail list", () => {
    // #given
    const pattern = termPattern("Glimmer", true);
    // #when
    const counts = hitCounts(pattern, ["Glimmers", "MAX_Glimmer"]);
    // #then
    assert.deepEqual(counts, [0, 1]);
  });
});

describe("private path pattern", () => {
  const ref = (before: string): string => `${before}${DOCS_DIR}/x.md`;

  it("catches a reference at a line start or after whitespace, quotes, backticks or brackets", () => {
    // #given
    const texts = ["", " ", "\t", "'", '"', "`", "(", "[", "see ", "line one\n"].map(ref);
    // #when
    const counts = hitCounts(PRIVATE_PATH, texts);
    // #then
    assert.deepEqual(
      counts,
      texts.map(() => 1),
    );
  });

  it("catches a leading slash after the same boundaries", () => {
    // #given
    const texts = ["/", "see /", "(/", '"/'].map(ref);
    // #when
    const counts = hitCounts(PRIVATE_PATH, texts);
    // #then
    assert.deepEqual(counts, [1, 1, 1, 1]);
  });

  it("catches relative references", () => {
    // #given
    const texts = ["./", "../", "../../", "x = ../"].map(ref);
    // #when
    const counts = hitCounts(PRIVATE_PATH, texts);
    // #then
    assert.deepEqual(counts, [1, 1, 1, 1]);
  });

  it("passes a folder of the same name inside another path", () => {
    // #given
    const texts = [
      "node_modules/pkg/",
      "github.com/org/repo/",
      "@scope/pkg/",
      "$ROOT/",
      "src/",
      "/home/user/vayle/",
    ].map(ref);
    // #when
    const counts = hitCounts(PRIVATE_PATH, texts);
    // #then
    assert.deepEqual(counts, [0, 0, 0, 0, 0, 0]);
  });

  it("needs the exact folder name followed by a slash", () => {
    // #given
    const texts = [`/${DOCS_DIR}`, `${DOCS_DIR}s/x`, `${DOCS_DIR}ize/x`, DOCS_DIR];
    // #when
    const counts = hitCounts(PRIVATE_PATH, texts);
    // #then
    assert.deepEqual(counts, [0, 0, 0, 0]);
  });
});
