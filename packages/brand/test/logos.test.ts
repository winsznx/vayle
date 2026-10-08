import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import check from "../../../deployments/market-check.json" with { type: "json" };
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import manifest from "../logos/manifest.json" with { type: "json" };

const dir = new URL("../logos/", import.meta.url);
const logos: Readonly<Record<string, { file: string; sha256: string; bytes: number }>> =
  manifest.logos;

describe("asset logos", () => {
  it("has a logo for every Stock Token in the market check and for USDG", () => {
    // #given
    const symbols = [...check.tokens.map((t) => t.symbol), facts.usdg.symbol];
    // #when
    const missing = symbols.filter((s) => logos[s] === undefined);
    // #then
    assert.deepEqual(missing, []);
  });

  it("keeps every file exactly as the manifest pins it", () => {
    // #when
    const changed = Object.entries(logos).filter(([, logo]) => {
      const bytes = readFileSync(new URL(logo.file, dir));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return sha256 !== logo.sha256 || bytes.length !== logo.bytes;
    });
    // #then
    assert.deepEqual(
      changed.map(([symbol]) => symbol),
      [],
    );
  });

  it("ships no image the manifest doesn't list", () => {
    // #given
    const listed = new Set(Object.values(logos).map((l) => l.file));
    // #when
    const extra = readdirSync(dir).filter((f) => /\.(png|webp)$/.test(f) && !listed.has(f));
    // #then
    assert.deepEqual(extra, []);
  });
});
