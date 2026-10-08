import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markets, type Market } from "@vayle/markets";
import { getAddress } from "viem";
import { marketOfToken, NoMarkets, selectMarket, withAsset } from "../src/app/assets.ts";

// The first market the build lists, and a made-up second one listed after it.
const first = markets.at(0);
if (first === undefined) throw new Error("the markets file lists no market");
const second: Market = {
  ...first,
  symbol: "ABC",
  token: getAddress("0x00000000000000000000000000000000000000cc"),
};
const listed = [first, second];

describe("selectMarket", () => {
  it("shows the first listed market when the URL names none", () => {
    // #when
    const market = selectMarket(listed, null);
    // #then
    assert.equal(market.token, first.token);
  });

  it("picks the market the URL names by its ticker, in any case", () => {
    // #when
    const picked = ["ABC", "abc", " Abc "].map((asked) => selectMarket(listed, asked).token);
    // #then
    assert.deepEqual(picked, [second.token, second.token, second.token]);
  });

  it("falls back to the first listed market for a ticker the build doesn't list", () => {
    // #when
    const market = selectMarket(listed, "NOPE");
    // #then
    assert.equal(market.token, first.token);
  });

  it("refuses a build that lists no market", () => {
    // #then
    assert.throws(() => selectMarket([], null), NoMarkets);
  });
});

describe("marketOfToken", () => {
  it("finds a listed market by its token, whatever the address's casing", () => {
    // #when
    const found = marketOfToken(listed, second.token.toLowerCase());
    // #then
    assert.equal(found?.symbol, "ABC");
  });

  it("finds nothing for a token the build doesn't list or a value that isn't an address", () => {
    // #when
    const found = [
      marketOfToken(listed, "0x00000000000000000000000000000000000000dd"),
      marketOfToken(listed, "ABC"),
    ];
    // #then
    assert.deepEqual(found, [undefined, undefined]);
  });
});

describe("withAsset", () => {
  it("keeps the chosen market on a link, beside the link's own query", () => {
    // #when
    const links = [withAsset("/orders", "ABC"), withAsset("/trade?price=12.5", "ABC")];
    // #then
    assert.deepEqual(links, ["/orders?asset=ABC", "/trade?price=12.5&asset=ABC"]);
  });

  it("leaves a link alone while the page shows the first market by default", () => {
    // #then
    assert.equal(withAsset("/trade?price=12.5", null), "/trade?price=12.5");
  });
});
