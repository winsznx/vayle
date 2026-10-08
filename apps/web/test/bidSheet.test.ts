import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { markets, type Market } from "@vayle/markets";
import { getAddress } from "viem";
import { makerBidsOf, parseBidSheet } from "../src/app/bidSheet.ts";
import type { Epoch } from "../src/app/week.ts";

const MARKET = getAddress("0x00000000000000000000000000000000000000aa");
const build = { chainId: 4663, market: MARKET };
const first = markets.at(0);
if (first === undefined) throw new Error("the markets file lists no market");
// A made-up second market listed after the first.
const second: Market = {
  ...first,
  symbol: "ABC",
  token: getAddress("0x00000000000000000000000000000000000000cc"),
};
const EXPIRY = 1_792_180_800;
const epoch: Epoch = {
  opening: EXPIRY - 7 * 86_400,
  expiry: EXPIRY,
  batchDeadline: EXPIRY - 5 * 86_400,
  windowLength: 7200,
  referencePrice: 238_410_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
  priceTick: 100n,
  lot: 10n ** 16n,
  rawUnit: 10n ** 18n,
};

function sheet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { chainId: 4663, market: MARKET.toLowerCase(), block: 82835060 },
    computedAt: 1_791_900_000,
    markets: [
      {
        token: second.token,
        symbol: "ABC",
        expiry: EXPIRY,
        round: { id: "18446744073709552799", updatedAt: 1791899900 },
        volBps: 3406,
        sell: [
          { target: "245000000", premium: "1250000", maxAmount: "2000000000000000000" },
          { target: "250000000", premium: "700000", maxAmount: "2000000000000000000" },
        ],
        buy: [{ target: "230000000", premium: "910000", maxAmount: "1000000000000000000" }],
      },
    ],
    ...overrides,
  };
}

describe("parseBidSheet", () => {
  it("reads the sheet's source, time and each market's bids, with integers from strings", () => {
    // #when
    const parsed = parseBidSheet(sheet(), build);
    // #then
    assert.deepEqual(
      parsed === null
        ? null
        : {
            block: parsed.block,
            computedAt: parsed.computedAt,
            sells: parsed.markets.at(0)?.sell.map((b) => b.premium),
            round: parsed.markets.at(0)?.priceRound,
          },
      {
        block: 82_835_060n,
        computedAt: 1_791_900_000,
        sells: [1_250_000n, 700_000n],
        round: 18_446_744_073_709_552_799n,
      },
    );
  });

  it("ignores a sheet for another chain or another market contract", () => {
    // #when
    const results = [
      parseBidSheet(sheet({ source: { chainId: 1, market: MARKET, block: "1" } }), build),
      parseBidSheet(
        sheet({
          source: {
            chainId: 4663,
            market: "0x00000000000000000000000000000000000000bb",
            block: "1",
          },
        }),
        build,
      ),
    ];
    // #then
    assert.deepEqual(results, [null, null]);
  });

  it("refuses a sheet with no source, no computed time or no market list", () => {
    // #when
    const results = [
      parseBidSheet({ ...sheet(), source: undefined }, build),
      parseBidSheet(sheet({ computedAt: "soon" }), build),
      parseBidSheet(sheet({ markets: { ABC: [] } }), build),
      parseBidSheet("not a sheet", build),
    ];
    // #then
    assert.deepEqual(results, [null, null, null, null]);
  });

  it("reads a computed time given as an ISO string", () => {
    // #when
    const parsed = parseBidSheet(sheet({ computedAt: "2026-10-08T14:00:00.000Z" }), build);
    // #then
    assert.equal(parsed?.computedAt, Date.UTC(2026, 9, 8, 14) / 1000);
  });

  it("leaves out bids that don't parse, pay nothing, cover nothing or repeat a target", () => {
    // #given
    const messy = sheet({
      markets: [
        {
          token: second.token,
          symbol: "ABC",
          expiry: EXPIRY,
          round: { id: "1", updatedAt: 1 },
          volBps: 1,
          sell: [
            { target: "245000000", premium: "1250000", maxAmount: "1" },
            { target: "245000000", premium: "9", maxAmount: "1" },
            { target: "250000000", premium: "0", maxAmount: "1" },
            { target: "255000000", premium: "1", maxAmount: "0" },
            { target: 2.5, premium: "1", maxAmount: "1" },
            "a bid",
          ],
          buy: "none",
        },
      ],
    });
    // #when
    const parsed = parseBidSheet(messy, build);
    // #then
    assert.deepEqual(
      [parsed?.markets.at(0)?.sell.map((b) => b.target), parsed?.markets.at(0)?.buy],
      [[245_000_000n], []],
    );
  });

  it("leaves out a market entry that doesn't parse and keeps the rest", () => {
    // #given
    const withBroken = sheet({
      markets: [{ token: "not an address" }, ...(sheet().markets as unknown[])],
    });
    // #when
    const parsed = parseBidSheet(withBroken, build);
    // #then
    assert.deepEqual(
      parsed?.markets.map((m) => m.symbol),
      ["ABC"],
    );
  });
});

describe("makerBidsOf", () => {
  it("gives one market's bids for the week it has open, per side and target", () => {
    // #given
    const parsed = parseBidSheet(sheet(), build);
    // #when
    const bids = makerBidsOf(parsed, second, epoch);
    // #then
    assert.deepEqual(
      bids === null
        ? null
        : { sell: [...bids.sell.entries()], buy: [...bids.buy.entries()], at: bids.computedAt },
      {
        sell: [
          [245_000_000n, 1_250_000n],
          [250_000_000n, 700_000n],
        ],
        buy: [[230_000_000n, 910_000n]],
        at: 1_791_900_000,
      },
    );
  });

  it("has nothing for a market the sheet doesn't price or a week it didn't price", () => {
    // #given
    const parsed = parseBidSheet(sheet(), build);
    // #when
    const results = [
      makerBidsOf(parsed, first, epoch),
      makerBidsOf(parsed, second, { ...epoch, expiry: EXPIRY + 7 * 86_400 }),
      makerBidsOf(null, second, epoch),
    ];
    // #then
    assert.deepEqual(results, [null, null, null]);
  });
});
