import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import {
  BadMarkets,
  listingDifferences,
  marketOf,
  markets,
  parseMarkets,
  problemsOf,
  strikeStepFor,
  type Listing,
  type Market,
} from "../src/index.ts";

const CHECK_FILE = new URL("../../../deployments/market-check.json", import.meta.url);
const USDG = 1_000_000n;

function nvda(): Market {
  const found = markets.find((m) => m.symbol === "NVDA");
  assert.ok(found, "NVDA is listed");
  return found;
}

describe("the committed markets file", () => {
  it("parses and every market is consistent", () => {
    // #given
    const listed = markets;
    // #when
    const problems = listed.map((m) => [m.symbol, problemsOf(m)] as const);
    // #then
    assert.ok(listed.length >= 1);
    for (const [symbol, found] of problems) assert.deepEqual(found, [], symbol);
  });

  it("lists NVDA with the token and feed the chain facts recorded", () => {
    // #given
    const market = nvda();
    // #then
    assert.equal(market.token, facts.nvda.address);
    assert.equal(market.uid, facts.nvda.uid);
    assert.equal(market.decimals, facts.nvda.decimals);
    assert.equal(market.feed, facts.nvdaUsdFeed.proxy);
    assert.equal(market.feedDecimals, facts.nvdaUsdFeed.decimals);
    assert.equal(market.heartbeatSeconds, facts.nvdaUsdFeed.heartbeatSeconds);
  });

  it("lists every other market as it passed the market check", () => {
    // #given
    const others = markets.filter((m) => m.symbol !== "NVDA");
    if (others.length === 0) return;
    assert.ok(existsSync(CHECK_FILE), "a market beyond NVDA needs deployments/market-check.json");
    const check = JSON.parse(readFileSync(CHECK_FILE, "utf8")) as {
      tokens: {
        symbol: string;
        address: string;
        uid: string;
        decimals: number;
        passed: boolean;
        checks: { feed: { proxy: string | null } };
      }[];
    };
    // #then
    for (const market of others) {
      const entry = check.tokens.find((t) => t.symbol === market.symbol);
      assert.ok(entry, `${market.symbol} is in the market check`);
      assert.equal(entry.passed, true, `${market.symbol} passed every check`);
      assert.equal(entry.address, market.token);
      assert.equal(entry.uid, market.uid);
      assert.equal(entry.decimals, market.decimals);
      assert.equal(entry.checks.feed.proxy, market.feed);
    }
  });

  it("finds a market by its token in any letter case", () => {
    // #given
    const market = nvda();
    // #when
    const found = marketOf(market.token.toLowerCase() as `0x${string}`);
    // #then
    assert.equal(found?.symbol, "NVDA");
  });
});

describe("strikeStepFor", () => {
  it("picks the 1, 2, 5 step nearest 2% of the price", () => {
    // #given
    const cases: [bigint, bigint][] = [
      [240n * USDG, 5n * USDG],
      [237_193_720n, 5n * USDG],
      [30n * USDG, USDG / 2n],
      [600n * USDG, 10n * USDG],
      [100n * USDG, 2n * USDG],
      [9n * USDG, USDG / 5n],
    ];
    // #when / #then
    for (const [price, step] of cases) assert.equal(strikeStepFor(price), step, `${price}`);
  });

  it("refuses a price of zero", () => {
    // #when / #then
    assert.throws(() => strikeStepFor(0n), BadMarkets);
  });
});

describe("parseMarkets", () => {
  const valid = JSON.parse(
    readFileSync(new URL("../../../deployments/markets.json", import.meta.url), "utf8"),
  ) as { schemaVersion: number; markets: Record<string, unknown>[] };

  function withFirst(change: (entry: Record<string, unknown>) => void): unknown {
    const copy = structuredClone(valid);
    const first = copy.markets[0];
    assert.ok(first);
    change(first);
    return copy;
  }

  it("refuses an unknown schema version", () => {
    // #given
    const json = { ...valid, schemaVersion: 2 };
    // #when / #then
    assert.throws(() => parseMarkets(json), /schemaVersion/);
  });

  it("refuses an address that isn't checksummed", () => {
    // #given
    const json = withFirst((m) => {
      m["token"] = String(m["token"]).toLowerCase();
    });
    // #when / #then
    assert.throws(() => parseMarkets(json), /token isn't a checksummed address/);
  });

  it("refuses a size written as a number, which could lose precision", () => {
    // #given
    const json = withFirst((m) => {
      m["lot"] = 10_000_000_000_000_000;
    });
    // #when / #then
    assert.throws(() => parseMarkets(json), /lot isn't text/);
  });

  it("refuses the same token twice", () => {
    // #given
    const copy = structuredClone(valid);
    const first = copy.markets[0];
    assert.ok(first);
    copy.markets.push({ ...first, symbol: "COPY" });
    // #when / #then
    assert.throws(() => parseMarkets(copy), /listed twice/);
  });
});

describe("problemsOf", () => {
  it("flags a side that's enabled with a zero cap, or disabled with caps", () => {
    // #given
    const market = nvda();
    const enabledEmpty: Market = {
      ...market,
      buy: { enabled: true, caps: { ...market.buy.caps, fillSize: 0n } },
    };
    const disabledFull: Market = { ...market, sell: { ...market.sell, enabled: false } };
    // #when / #then
    assert.ok(problemsOf(enabledEmpty).includes("buy is enabled with a zero cap"));
    assert.ok(problemsOf(disabledFull).includes("sell is disabled with a nonzero cap"));
  });

  it("flags caps that don't nest or aren't whole lots", () => {
    // #given
    const market = nvda();
    const caps = market.sell.caps;
    const wide: Market = {
      ...market,
      sell: { enabled: true, caps: { ...caps, fillSize: caps.seriesOpenInterest + market.lot } },
    };
    const ragged: Market = {
      ...market,
      sell: { enabled: true, caps: { ...caps, walletSize: caps.walletSize + 1n } },
    };
    // #when / #then
    assert.ok(problemsOf(wide).some((p) => p.includes("don't nest")));
    assert.ok(problemsOf(ragged).includes("sell has a cap that isn't whole lots"));
  });

  it("flags a fixed dollar step that doesn't fit the price", () => {
    // #given: NVDA's $5 step on a $30 token
    const market: Market = { ...nvda(), strikeStepBasis: { priceUsdg: 30n * USDG, block: 1n } };
    // #when / #then
    assert.ok(problemsOf(market).includes("strike tick doesn't follow the strike step rule"));
  });

  it("flags a maker vol that isn't realized vol plus the margin", () => {
    // #given
    const market = nvda();
    const off: Market = { ...market, maker: { ...market.maker, volBps: market.maker.volBps + 1 } };
    // #when / #then
    assert.ok(problemsOf(off).includes("maker vol isn't realized vol plus the margin"));
  });
});

describe("listingDifferences", () => {
  // The listing the registry holds after the deploy listed the market from the file.
  function listingOf(m: Market, overrides: Partial<Listing> = {}): Listing {
    return {
      uid: m.uid,
      feed: m.feed,
      decimals: m.decimals,
      feedDecimals: m.feedDecimals,
      rawUnit: m.rawUnit,
      lot: m.lot,
      priceTick: m.priceTick,
      strikeTick: m.strikeTick,
      strikeRangeBps: m.strikeRangeBps,
      listed: true,
      ...overrides,
    };
  }

  it("finds nothing when the registry lists the market as the file states it", () => {
    // #when
    const differences = listingDifferences(nvda(), listingOf(nvda()));
    // #then
    assert.deepEqual(differences, []);
  });

  it("names each field the registry lists differently, with both values", () => {
    // #given: a listing whose strike tick and band aren't the file's
    const listing = listingOf(nvda(), { strikeTick: 10_000_000n, strikeRangeBps: 500 });
    // #when
    const differences = listingDifferences(nvda(), listing);
    // #then
    assert.deepEqual(differences, [
      "strikeTick is 10000000 in the registry and 5000000 in the markets file",
      "strikeRangeBps is 500 in the registry and 1000 in the markets file",
    ]);
  });

  it("compares the feed whatever the letter case it comes back in", () => {
    // #given
    const listing = listingOf(nvda(), { feed: nvda().feed.toLowerCase() as `0x${string}` });
    // #when
    const differences = listingDifferences(nvda(), listing);
    // #then
    assert.deepEqual(differences, []);
  });
});
