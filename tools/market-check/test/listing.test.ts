import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listTokens } from "../src/listing.ts";

const REGISTRY = {
  assets: [
    {
      id: "0x02",
      tokenSymbol: "ZZZ",
      tokenDecimals: 18,
      status: "ASSET_STATUS_ACTIVE",
      deployments: [
        { chainId: 4663, contractAddress: "0x2222222222222222222222222222222222222222" },
      ],
    },
    {
      id: "0x01",
      tokenSymbol: "AAA",
      tokenDecimals: 18,
      status: "ASSET_STATUS_INACTIVE",
      deployments: [
        { chainId: 4663, contractAddress: "0x1111111111111111111111111111111111111111" },
      ],
    },
    {
      id: "0x03",
      tokenSymbol: "OFF",
      tokenDecimals: 18,
      status: "ASSET_STATUS_ACTIVE",
      deployments: [{ chainId: 1, contractAddress: "0x3333333333333333333333333333333333333333" }],
    },
  ],
};

const DIRECTORY = [
  {
    name: "Robinhood ZZZ / USD",
    proxyAddress: "0x4444444444444444444444444444444444444444",
    contractAddress: "0x5555555555555555555555555555555555555555",
    decimals: 8,
    heartbeat: 86_400,
    threshold: 0.5,
    docs: {
      baseAsset: "ZZZ",
      productTypeCode: "primaryTokenizedPrice",
      marketHours: "us_equities_24/5",
    },
  },
  {
    name: "Robinhood AAA-USD",
    proxyAddress: "0x6666666666666666666666666666666666666666",
    contractAddress: "0x7777777777777777777777777777777777777777",
    decimals: 8,
    heartbeat: 86_400,
    threshold: 0.5,
    docs: { baseAssetEntityId: "crypto-RHAAA", marketHours: "us_equities_24/5" },
  },
];

describe("listTokens", () => {
  it("lists every token deployed on the chain, by symbol, with its tokenized price feed", () => {
    // #given
    const registry = REGISTRY;
    // #when
    const listing = listTokens(registry, DIRECTORY, 4663);
    // #then
    assert.deepEqual(
      listing.tokens.map((t) => [
        t.asset.symbol,
        t.asset.status,
        typeof t.feed === "string" ? null : t.feed.proxy,
      ]),
      [
        ["AAA", "ASSET_STATUS_INACTIVE", null],
        ["ZZZ", "ASSET_STATUS_ACTIVE", "0x4444444444444444444444444444444444444444"],
      ],
    );
  });

  it("skips a symbol with no deployment on the chain", () => {
    // #given
    const registry = REGISTRY;
    // #when
    const listing = listTokens(registry, DIRECTORY, 4663);
    // #then
    assert.deepEqual(
      listing.skipped.map((s) => s.symbol),
      ["OFF"],
    );
  });

  it("matches feeds by baseAsset only for primaryTokenizedPrice entries", () => {
    // #given
    // AAA's entry has no productTypeCode, so it isn't AAA's feed.
    const registry = REGISTRY;
    // #when
    const listing = listTokens(registry, DIRECTORY, 4663);
    // #then
    assert.equal(
      listing.tokens.find((t) => t.asset.symbol === "AAA")?.feed,
      "the feed directory lists AAA: 0 tokenized price feeds, expected 1",
    );
  });
});
