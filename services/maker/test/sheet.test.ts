import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { premiumFor } from "../src/plan.ts";
import { bidSheet } from "../src/sheet.ts";
import {
  BID_OPEN,
  bucket,
  CALL_STRIKE,
  nvda,
  NVDA,
  OCT_09,
  ONE,
  other,
  OTHER,
  PRICE,
  prices,
  pricing,
  PUT_STRIKE,
  snapshot,
  state,
  STOOD_DOWN,
  WEDNESDAY,
} from "./fixtures.ts";

const CONFIG = {
  chainId: 4663,
  market: "0x00000000000000000000000000000000000000aA" as const,
  pricing,
};

// Mid-week, quoting, with a $245 and a $250 sell target and a $230 buy target listed.
const LISTED = [
  bucket(),
  bucket({ strike: 250_000_000n, series: 13n, registered: false }),
  bucket({ side: 1, strike: PUT_STRIKE, series: 12n, fillSize: 2n * ONE, seriesRoom: 4n * ONE }),
];

describe("bidSheet", () => {
  it("lists each target with the premium and size a quote would carry", () => {
    // #given
    const s = snapshot({ markets: [state({ buckets: LISTED })] });
    const m = state({ buckets: LISTED });
    const premium = (side: number, strike: bigint): string =>
      (premiumFor(s, m, pricing, PRICE, side, strike) ?? 0n).toString();
    // #when
    const sheet = bidSheet(s, CONFIG, prices());
    // #then: one fill's cap of 2 NVDA binds both sides
    assert.deepEqual(sheet, {
      computedAt: WEDNESDAY,
      source: { chainId: 4663, market: CONFIG.market, block: 82_900_000 },
      markets: [
        {
          symbol: "NVDA",
          token: NVDA,
          expiry: OCT_09,
          round: { id: "1", updatedAt: PRICE.updatedAt },
          volBps: nvda().maker.volBps,
          sell: [
            {
              target: "245000000",
              premium: premium(0, CALL_STRIKE),
              maxAmount: "2000000000000000000",
            },
            {
              target: "250000000",
              premium: premium(0, 250_000_000n),
              maxAmount: "2000000000000000000",
            },
          ],
          buy: [
            {
              target: "230000000",
              premium: premium(1, PUT_STRIKE),
              maxAmount: "2000000000000000000",
            },
          ],
        },
      ],
    });
  });

  it("lists nothing on a side the markets file disables", () => {
    // #given: buy targets off
    const sellOnly = other({ buy: { enabled: false, caps: { ...nvda().buy.caps } } });
    const s = snapshot({ markets: [state({ market: sellOnly, buckets: LISTED })] });
    // #when
    const sheet = bidSheet(s, CONFIG, prices([OTHER, PRICE]));
    // #then
    assert.deepEqual(
      sheet.markets.map((m) => [m.sell.length, m.buy.length]),
      [[2, 0]],
    );
  });

  it("leaves out a target the maker wouldn't buy any of", () => {
    // #given: no NVDA to deliver on a put, and no room left in the $250 series
    const buckets = LISTED.map((b) => (b.strike === 250_000_000n ? { ...b, seriesRoom: 0n } : b));
    const s = snapshot({ markets: [state({ buckets, balance: 0n })] });
    // #when
    const sheet = bidSheet(s, CONFIG, prices());
    // #then
    assert.deepEqual(
      sheet.markets.map((m) => [m.sell.map((t) => t.target), m.buy.map((t) => t.target)]),
      [[["245000000"], []]],
    );
  });

  it("leaves out a market whose price the guard stood down, or that has no week", () => {
    // #given
    const s = snapshot({
      markets: [state({ buckets: LISTED }), state({ market: other(), epoch: null })],
    });
    // #when
    const sheet = bidSheet(s, CONFIG, prices([NVDA, STOOD_DOWN], [OTHER, PRICE]));
    // #then
    assert.deepEqual(sheet.markets, []);
  });

  it("lists no targets while the maker isn't quoting", () => {
    // #given: the bid window, before the batch deadline, and mid-week with quoting off
    const bidding = snapshot({ now: BID_OPEN, markets: [state({ buckets: LISTED })] });
    const quiet = snapshot({ markets: [state({ buckets: LISTED })] });
    // #when
    const sheets = [
      bidSheet(bidding, CONFIG, prices()),
      bidSheet(quiet, { ...CONFIG, pricing: { ...pricing, rfq: false } }, prices()),
    ];
    // #then
    assert.deepEqual(
      sheets.map((sheet) => sheet.markets.map((m) => [m.symbol, m.sell, m.buy])),
      [[["NVDA", [], []]], [["NVDA", [], []]]],
    );
  });

  it("is plain JSON", () => {
    // #given
    const sheet = bidSheet(snapshot({ markets: [state({ buckets: LISTED })] }), CONFIG, prices());
    // #when
    const text = JSON.stringify(sheet);
    // #then
    assert.deepEqual(JSON.parse(text), sheet);
  });
});
