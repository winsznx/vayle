import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCS_DIR } from "../src/config.ts";
import { parseNameList, type NameLists } from "../src/lists.ts";
import {
  isBinary,
  scanEnvTemplate,
  scanFile,
  scanText,
  skipsNameScan,
  type Finding,
} from "../src/scan.ts";

const lists: NameLists = {
  fail: parseNameList("Zorblax\nAcme Widget\n", false, "fail"),
  warn: parseNameList("Glimmer\n", true, "warn"),
  notices: [],
};

function kinds(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.kind}@${f.line}`);
}

describe("scanText", () => {
  it("reports path, fail and warn findings with their line numbers", () => {
    // #given
    const text = `clean line\nuses zorblax here\nGlimmer\nsee ${DOCS_DIR}/notes.md\n`;
    // #when
    const findings = scanText(text, "f", { lists, scanNames: true });
    // #then
    assert.deepEqual(kinds(findings), ["path@4", "fail@2", "warn@3"]);
  });

  it("puts a path finding on the reference's own line when the boundary is a newline", () => {
    // #given
    const text = `first\n${DOCS_DIR}/x.md\n`;
    // #when
    const findings = scanText(text, "f", { lists, scanNames: true });
    // #then
    assert.deepEqual(kinds(findings), ["path@2"]);
  });

  it("counts lines through Windows line endings", () => {
    // #given
    const text = "one\r\ntwo\r\nZorblax\r\n";
    // #when
    const findings = scanText(text, "f", { lists, scanNames: true });
    // #then
    assert.deepEqual(kinds(findings), ["fail@3"]);
  });

  it("still runs the path check when names are skipped", () => {
    // #given
    const text = `Zorblax ${DOCS_DIR}/x\n`;
    // #when
    const findings = scanText(text, "f", { lists, scanNames: false });
    // #then
    assert.deepEqual(kinds(findings), ["path@1"]);
  });
});

describe("skipsNameScan", () => {
  it("skips lockfiles and generated output", () => {
    // #given
    const paths = [
      "pnpm-lock.yaml",
      "apps/web/pnpm-lock.yaml",
      "contracts/out/Foo.sol/Foo.json",
      "contracts/cache/solidity-files-cache.json",
      "apps/web/.next/server/page.js",
      "packages/sdk/dist/index.js",
      "node_modules/pkg/index.js",
      "apps/web/coverage/lcov.info",
    ];
    // #when
    const skipped = paths.map(skipsNameScan);
    // #then
    assert.deepEqual(
      skipped,
      paths.map(() => true),
    );
  });

  it("scans source paths, including folders that only sound generated", () => {
    // #given
    const paths = [
      "README.md",
      "contracts/src/Vault.sol",
      "packages/x/src/build/plan.ts",
      "packages/x/src/out/writer.ts",
      "contracts/outbox/A.sol",
    ];
    // #when
    const skipped = paths.map(skipsNameScan);
    // #then
    assert.deepEqual(
      skipped,
      paths.map(() => false),
    );
  });
});

describe("scanFile", () => {
  it("skips names but keeps the path check in a lockfile", () => {
    // #given
    const text = `zorblax-sha512-abc\nresolution: ${DOCS_DIR}/x\n`;
    // #when
    const findings = scanFile("pnpm-lock.yaml", text, { lists, scanNames: true });
    // #then
    assert.deepEqual(kinds(findings), ["path@2"]);
  });

  it("scans the file name itself", () => {
    // #given
    const path = "docs/zorblax-notes.md";
    // #when
    const findings = scanFile(path, "clean\n", { lists, scanNames: true });
    // #then
    assert.deepEqual(
      findings.map((f) => f.location),
      ["docs/zorblax-notes.md (file name)"],
    );
  });

  it("checks the env template for values", () => {
    // #given
    const text = "# rpc\nRPC_URL=\nAPI_KEY=abc\n";
    // #when
    const findings = scanFile(".env.example", text, { lists, scanNames: true });
    // #then
    assert.deepEqual(kinds(findings), ["env@3"]);
  });
});

describe("scanEnvTemplate", () => {
  it("accepts comments, blank lines and bare keys", () => {
    // #given
    const text = "# a\n\nA=\nB_2=\n";
    // #when
    const findings = scanEnvTemplate(text, ".env.example");
    // #then
    assert.deepEqual(findings, []);
  });

  it("flags values, quoted values, inline text, lowercase keys and export prefixes", () => {
    // #given
    const text = 'A=1\nB=""\nC= # note\nlower=\nexport D=\n';
    // #when
    const findings = scanEnvTemplate(text, ".env.example");
    // #then
    assert.deepEqual(kinds(findings), ["env@1", "env@2", "env@3", "env@4", "env@5"]);
  });
});

describe("isBinary", () => {
  it("flags content with a NUL byte near the start and passes plain text", () => {
    // #given
    const binary = new Uint8Array([0x89, 0x50, 0x00, 0x47]);
    const text = new TextEncoder().encode("plain text");
    // #when
    const results = [isBinary(binary), isBinary(text)];
    // #then
    assert.deepEqual(results, [true, false]);
  });
});
