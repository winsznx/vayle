import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AssetNotListed, FeedNotListed } from "../src/errors.ts";
import {
  addressesOnPage,
  hasUptimeFeed,
  pageStates,
  selectEquityFeed,
  selectRegistryAsset,
} from "../src/sources.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

function asset(symbol: string, chainId: number, address: string): Record<string, unknown> {
  return {
    id: `0x${"ab".repeat(16)}`,
    tokenSymbol: symbol,
    tokenDecimals: 18,
    status: "ASSET_STATUS_ACTIVE",
    deployments: [{ contractAddress: address, chainId }],
  };
}

function feed(base: string, product: string, proxy: string): Record<string, unknown> {
  return {
    name: `${base} / USD`,
    proxyAddress: proxy,
    secondaryProxyAddress: null,
    contractAddress: B,
    decimals: 8,
    heartbeat: 86400,
    threshold: 0.5,
    docs: { baseAsset: base, productTypeCode: product, marketHours: "us_equities_24/5" },
  };
}

describe("selectRegistryAsset", () => {
  it("picks the one deployment of the symbol on the requested chain", () => {
    // #given
    const json = { assets: [asset("AAA", 1, A), asset("TKN", 7, A), asset("TKN", 9, B)] };
    // #when
    const selected = selectRegistryAsset(json, "TKN", 9);
    // #then
    assert.equal(selected.address, B);
  });

  it("refuses when the symbol has no deployment on the chain", () => {
    // #given
    const json = { assets: [asset("TKN", 7, A)] };
    // #when
    const select = (): unknown => selectRegistryAsset(json, "TKN", 9);
    // #then
    assert.throws(select, AssetNotListed);
  });

  it("refuses when two entries claim the symbol on the same chain", () => {
    // #given
    const json = { assets: [asset("TKN", 9, A), asset("TKN", 9, B)] };
    // #when
    const select = (): unknown => selectRegistryAsset(json, "TKN", 9);
    // #then
    assert.throws(select, AssetNotListed);
  });

  it("skips entries with an invalid address instead of trusting them", () => {
    // #given
    const json = { assets: [asset("TKN", 9, "0xnot-an-address")] };
    // #when
    const select = (): unknown => selectRegistryAsset(json, "TKN", 9);
    // #then
    assert.throws(select, AssetNotListed);
  });
});

describe("selectEquityFeed", () => {
  it("picks the primary tokenized price feed for the base asset", () => {
    // #given
    const json = [feed("TKN", "ExRate", A), feed("TKN", "primaryTokenizedPrice", B)];
    // #when
    const selected = selectEquityFeed(json, "TKN");
    // #then
    assert.equal(selected.proxy, B);
  });

  it("refuses when no tokenized price feed exists for the asset", () => {
    // #given
    const json = [feed("OTHER", "primaryTokenizedPrice", A)];
    // #when
    const select = (): unknown => selectEquityFeed(json, "TKN");
    // #then
    assert.throws(select, FeedNotListed);
  });
});

describe("hasUptimeFeed", () => {
  it("finds an uptime or sequencer entry and nothing else", () => {
    // #given
    const withFeed = [
      feed("TKN", "primaryTokenizedPrice", A),
      { name: "L2 Sequencer Uptime Status Feed" },
    ];
    const without = [feed("TKN", "primaryTokenizedPrice", A)];
    // #when
    const results = [hasUptimeFeed(withFeed), hasUptimeFeed(without)];
    // #then
    assert.deepEqual(results, [true, false]);
  });
});

describe("addressesOnPage", () => {
  it("collects distinct checksummed addresses and ignores longer hex strings", () => {
    // #given
    const html = `<td>${A}</td><td>${A.toUpperCase().replace("0X", "0x")}</td><td>0x${"ab".repeat(32)}</td>`;
    // #when
    const found = addressesOnPage(html);
    // #then
    assert.deepEqual([...found], [A]);
  });
});

describe("pageStates", () => {
  it("matches text case-insensitively", () => {
    // #given
    const html = "<p>Chain ID</p><p>4663</p><p>0xAbC</p>";
    // #when
    const results = [
      pageStates(html, "4663"),
      pageStates(html, "0xabc"),
      pageStates(html, "46630"),
    ];
    // #then
    assert.deepEqual(results, [true, true, false]);
  });
});
