import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const dir = new URL("../assets/tokens/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as {
  icons: Record<
    string,
    { file: string; sha256: string; bytes: number; width: number; height: number }
  >;
};

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("asset logos", () => {
  it("ship exactly the files the manifest names", () => {
    // #given
    const named = Object.values(manifest.icons)
      .map((i) => i.file)
      .sort();
    // #when
    const onDisk = readdirSync(dir)
      .filter((f) => f !== "manifest.json")
      .sort();
    // #then
    assert.deepEqual(onDisk, named);
  });

  it("match the bytes, size and dimensions the manifest pins", () => {
    // #when
    const mismatches = Object.entries(manifest.icons).flatMap(([symbol, icon]) => {
      const bytes = readFileSync(new URL(icon.file, dir));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const { width, height } = pngSize(bytes);
      const ok =
        sha256 === icon.sha256 &&
        bytes.length === icon.bytes &&
        width === icon.width &&
        height === icon.height;
      return ok ? [] : [symbol];
    });
    // #then
    assert.deepEqual(mismatches, []);
  });
});
