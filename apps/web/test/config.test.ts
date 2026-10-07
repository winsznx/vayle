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

  it("names every setting that's missing", () => {
    // #when
    const result = loadConfig({});
    // #then
    assert.deepEqual(result, { ok: false, missing: ["VITE_RPC_URL", "VITE_MARKET"] });
  });
});
