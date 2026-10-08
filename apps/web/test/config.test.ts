import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/app/config.ts";

const BASE = {
  VITE_RPC_URL: "http://127.0.0.1:8545",
  VITE_MARKET: "0xD372B11d62Ac2eD8E64BC8c3E2382a8e9972974B",
};

function placement(value?: string): boolean | null {
  const result = loadConfig(value === undefined ? BASE : { ...BASE, VITE_PLACEMENT: value });
  return result.ok ? result.config.placement : null;
}

describe("loadConfig", () => {
  it("keeps placement off when the build doesn't set it", () => {
    // #then
    assert.equal(placement(), false);
  });

  it("opens placement only for the exact value open", () => {
    // #when
    const values = ["open", "true", "1", "OPEN", ""].map(placement);
    // #then
    assert.deepEqual(values, [true, false, false, false, false]);
  });

  it("reads history from the chain from a deploy block, and refuses one that isn't a number", () => {
    // #when
    const ok = loadConfig({ ...BASE, VITE_MARKET_DEPLOY_BLOCK: "82090864" });
    const bad = loadConfig({ ...BASE, VITE_MARKET_DEPLOY_BLOCK: "soon" });
    // #then
    assert.deepEqual(
      [ok.ok ? ok.config.deployBlock : null, bad.ok ? null : bad.missing],
      [82_090_864n, ["VITE_MARKET_DEPLOY_BLOCK"]],
    );
  });

  it("reads the maker's bid sheet from a base URL, without its trailing slash", () => {
    // #when
    const result = loadConfig({ ...BASE, VITE_MAKER_URL: "https://maker.example/" });
    // #then
    assert.equal(result.ok ? result.config.makerUrl : null, "https://maker.example");
  });

  it("reads no bid sheet without a maker URL, and refuses one that isn't http or https", () => {
    // #when
    const results = [
      loadConfig(BASE),
      loadConfig({ ...BASE, VITE_MAKER_URL: "maker.example" }),
      loadConfig({ ...BASE, VITE_MAKER_URL: "ftp://maker.example" }),
    ];
    // #then
    assert.deepEqual(
      results.map((r) => (r.ok ? r.config.makerUrl : r.missing)),
      [null, ["VITE_MAKER_URL"], ["VITE_MAKER_URL"]],
    );
  });

  it("names every setting that's missing", () => {
    // #when
    const result = loadConfig({});
    // #then
    assert.deepEqual(result, { ok: false, missing: ["VITE_RPC_URL", "VITE_MARKET"] });
  });
});
