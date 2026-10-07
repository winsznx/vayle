import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  MARK_HELD_PATH,
  MARK_LADDER_PATH,
  MARK_PATH,
  MARK_SMALL_PATH,
  MARK_SMALL_VIEWBOX,
  MARK_VIEWBOX,
} from "../src/mark.ts";

const source = new URL("../source/", import.meta.url);
const favicon = new URL("../favicon/", import.meta.url);
const publicDir = new URL("../../../apps/web/public/", import.meta.url);

const read = (dir: URL, file: string): string => readFileSync(new URL(file, dir), "utf8");
const masters = readdirSync(source).filter((f) => f.endsWith(".svg"));
const twoColour = (svg: string): boolean =>
  svg.includes(`d="${MARK_LADDER_PATH}"`) && svg.includes(`d="${MARK_HELD_PATH}"`);
const oneColour = (svg: string): boolean => svg.includes(`d="${MARK_PATH}"`);

function pngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("svg masters", () => {
  it("cover every mark in every colourway", () => {
    // #given
    const marks = ["symbol", "wordmark", "lockup-horizontal", "lockup-stacked"];
    const ways = ["", "-mono-black", "-mono-white", "-reversed"];
    // #when
    const missing = marks
      .flatMap((m) => ways.map((w) => `vayle-${m}${w}.svg`))
      .filter((f) => !masters.includes(f));
    // #then
    assert.deepEqual(missing, []);
    assert.ok(masters.includes("vayle-app-icon.svg"));
  });

  it("draw the symbol from the current mark source", () => {
    // #given
    const withSymbol = masters.filter((f) => !f.startsWith("vayle-wordmark"));
    // #when
    const stale = withSymbol.filter((f) => {
      const svg = read(source, f);
      return f.includes("-mono-") || f === "vayle-app-icon.svg" ? !oneColour(svg) : !twoColour(svg);
    });
    // #then
    assert.deepEqual(stale, []);
    assert.ok(read(source, "vayle-symbol.svg").includes(`viewBox="${MARK_VIEWBOX}"`));
  });

  it("carry no text, scripts, images or outside references", () => {
    // #given
    const forbidden = [/<text/i, /<script/i, /<image/i, /<foreignObject/i, /href=/i, /url\(/i];
    // #when
    const unsafe = [...masters.map((f) => read(source, f)), read(favicon, "favicon.svg")].filter(
      (svg) => forbidden.some((pattern) => pattern.test(svg)) || !svg.includes("viewBox="),
    );
    // #then
    assert.equal(unsafe.length, 0);
  });
});

describe("icons", () => {
  it("draw the favicon from the small symbol", () => {
    // #when
    const svg = read(favicon, "favicon.svg");
    // #then
    assert.ok(svg.includes(`viewBox="${MARK_SMALL_VIEWBOX}"`));
    assert.ok(svg.includes(`d="${MARK_SMALL_PATH}"`));
  });

  it("render at the sizes their names promise", () => {
    // #given
    const sizes: Record<string, number> = {
      "favicon-16.png": 16,
      "favicon-32.png": 32,
      "favicon-48.png": 48,
      "apple-touch-icon.png": 180,
      "icon-192.png": 192,
      "icon-512.png": 512,
      "icon-maskable-512.png": 512,
    };
    // #when
    const wrong = Object.entries(sizes).filter(([file, px]) => {
      const { width, height } = pngSize(readFileSync(new URL(file, favicon)));
      return width !== px || height !== px;
    });
    // #then
    assert.deepEqual(wrong, []);
  });

  it("pack 16, 32 and 48 px frames into the ico", () => {
    // #given
    const ico = readFileSync(new URL("favicon.ico", favicon));
    // #when
    const count = ico.readUInt16LE(4);
    const frames = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + i * 16)).sort(
      (a, b) => a - b,
    );
    // #then
    assert.equal(ico.readUInt16LE(2), 1);
    assert.deepEqual(frames, [16, 32, 48]);
  });

  it("match what the web app serves", () => {
    // #given
    const served = readdirSync(publicDir).filter((f) => /^(favicon|apple-touch|icon-)/.test(f));
    // #when
    const drifted = served.filter(
      (f) => !readFileSync(new URL(f, publicDir)).equals(readFileSync(new URL(f, favicon))),
    );
    // #then
    assert.deepEqual(served.sort(), [
      "apple-touch-icon.png",
      "favicon.ico",
      "favicon.svg",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
    ]);
    assert.deepEqual(drifted, []);
  });
});
