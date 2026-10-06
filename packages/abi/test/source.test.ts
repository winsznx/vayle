import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "../src/index.ts";
import { kebab, moduleSource } from "../src/source.ts";

describe("kebab", () => {
  it("splits camel-case contract names into file names", () => {
    // #when
    const names = ["VayleMarket", "StockTokenRegistry", "PriceAdapter"].map(kebab);
    // #then
    assert.deepEqual(names, ["vayle-market", "stock-token-registry", "price-adapter"]);
  });
});

describe("moduleSource", () => {
  it("exports the ABI as a const named after the contract", () => {
    // #when
    const source = moduleSource("PriceAdapter", []);
    // #then
    assert.match(source, /^export const priceAdapterAbi = \[\] as const;$/m);
  });
});

describe("generated ABIs", () => {
  it("include the guard events the watcher listens for", () => {
    // #given
    const wanted = ["HaltStarted", "HaltExtended", "HaltEnded", "OraclePauseObserved", "CapsSet"];
    // #when
    const events = new Set<string>(
      vayleMarketAbi.filter((e) => e.type === "event").map((e) => e.name),
    );
    // #then
    assert.deepEqual(
      wanted.filter((name) => !events.has(name)),
      [],
    );
  });
});
