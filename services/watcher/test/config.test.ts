import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markets } from "@vayle/markets";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { loadConfig } from "../src/config.ts";
import { MarketConfigIncomplete, MissingSetting } from "../src/errors.ts";

const base = {
  ROBINHOOD_RPC_URL: "https://rpc.example",
  WATCHER_WEBHOOK_URL: "https://hooks.example/alerts",
  SUPABASE_URL: "https://project.supabase.example",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

describe("loadConfig", () => {
  it("watches the dependencies alone until the market is deployed", () => {
    // #when
    const config = loadConfig(base);
    // #then
    assert.equal(config.market, null);
  });

  it("names a missing setting", () => {
    // #when
    const load = (): unknown => loadConfig({ ...base, WATCHER_WEBHOOK_URL: "" });
    // #then
    assert.throws(load, MissingSetting);
  });

  it("refuses a partial market configuration", () => {
    // #when
    const load = (): unknown =>
      loadConfig({ ...base, VAYLE_MARKET: "0x0000000000000000000000000000000000000001" });
    // #then
    assert.throws(load, MarketConfigIncomplete);
  });

  it("reads USDG from the chain facts", () => {
    // #when
    const config = loadConfig(base);
    // #then
    assert.equal(config.usdg, facts.usdg.address);
  });

  it("watches every market in the markets file", () => {
    // #when
    const config = loadConfig(base);
    // #then
    assert.deepEqual(
      config.markets.map((m) => m.token),
      markets.map((m) => m.token),
    );
  });
});
