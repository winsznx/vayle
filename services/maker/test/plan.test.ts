import assert from "node:assert/strict";
import { describe, it } from "node:test";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import type { PricingConfig } from "../src/config.ts";
import type { PriceReading, StandDown, UsablePrice } from "../src/guard.ts";
import {
  LOW_ALLOWANCE,
  plan,
  premiumFor,
  type Bucket,
  type Holding,
  type IdleOrder,
  type MakerAction,
  type MakerSnapshot,
} from "../src/plan.ts";

const MAKER = "0x000000000000000000000000000000000000beef";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ONE = 10n ** 18n;
const LOT = 10n ** 16n;
const OCT_02 = 1_790_971_200;
const OCT_09 = 1_791_576_000;
const DEADLINE = 1_791_207_000 - 48_600;
const BID_OPEN = OCT_02 + 7200;
const WEDNESDAY = 1_791_374_400;
const CALL_STRIKE = 245_000_000n;
const PUT_STRIKE = 230_000_000n;
const FEED_DECIMALS = facts.nvdaUsdFeed.decimals;

// What the guard hands the plan when the price is fine, and when it isn't.
const PRICE: UsablePrice = { usable: true, spot: 240, roundId: 1n };
const STAND_DOWN: StandDown = {
  usable: false,
  reason: "OraclePaused",
  detail: "the token's oracle is paused",
};

// The feed's reads with a latest answer of `usd` dollars, which exercise judges the money on.
function answered(usd: bigint): PriceReading {
  return {
    round: {
      ok: true,
      value: { roundId: 1n, answer: usd * 10n ** BigInt(FEED_DECIMALS), updatedAt: OCT_02 },
    },
    feedDecimals: { ok: true, value: FEED_DECIMALS },
    oraclePaused: { ok: true, value: false },
    reference: 240_000_000n,
  };
}

const pricing: PricingConfig = {
  vol: 0.45,
  grossDividendYield: 0.0002,
  rate: 0.04,
  edgeBps: 2000,
  maxPerSeries: 5n * ONE,
  rfq: true,
};

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    side: 0,
    strike: CALL_STRIKE,
    series: 11n,
    registered: true,
    bestBidder: null,
    ownBid: null,
    fillSize: 2n * ONE,
    seriesRoom: 6n * ONE,
    ...overrides,
  };
}

function snapshot(overrides: Partial<MakerSnapshot> = {}): MakerSnapshot {
  return {
    now: WEDNESDAY,
    maker: MAKER,
    asset: NVDA,
    usdg: USDG,
    usdgDecimals: 6,
    feeBps: 0,
    bidWindow: 7200,
    price: answered(240n),
    epoch: {
      opening: OCT_02,
      expiry: OCT_09,
      batchDeadline: DEADLINE,
      windowLength: 7200,
      lot: LOT,
      priceTick: 100n,
      rawUnit: ONE,
    },
    buckets: [],
    idle: [],
    holdings: [],
    usdgBalance: 100_000n * 10n ** 6n,
    assetBalance: 10n * ONE,
    usdgAllowance: LOW_ALLOWANCE,
    assetAllowance: LOW_ALLOWANCE,
    claimableUsdg: 0n,
    claimableAsset: 0n,
    ...overrides,
  };
}

function kinds(actions: readonly MakerAction[]): string[] {
  return actions.map((a) => a.kind);
}

describe("maker plan", () => {
  it("does nothing on a quiet Wednesday", () => {
    // #when
    const actions = plan(snapshot(), pricing, PRICE);
    // #then
    assert.deepEqual(actions, []);
  });

  it("approves and withdraws before anything else", () => {
    // #given
    const s = snapshot({ usdgAllowance: 0n, claimableAsset: ONE });
    // #when
    const actions = plan(s, pricing, PRICE);
    // #then
    assert.deepEqual(kinds(actions), ["approve", "withdraw"]);
  });

  it("bids into each bucket once the bid window opens, registering a series first", () => {
    // #given
    const s = snapshot({
      now: BID_OPEN,
      buckets: [bucket(), bucket({ side: 1, strike: PUT_STRIKE, series: 12n, registered: false })],
    });
    // #when
    const actions = plan(s, pricing, PRICE);
    // #then
    assert.deepEqual(kinds(actions), ["bid", "register"]);
  });

  it("doesn't bid again in a bucket where it's already the best bidder", () => {
    // #given
    const s = snapshot({ now: BID_OPEN, buckets: [bucket({ bestBidder: MAKER })] });
    // #when
    const actions = plan(s, pricing, PRICE);
    // #then
    assert.deepEqual(actions, []);
  });

  it("bids at the priced premium, for at most its per-series limit", () => {
    // #given
    const s = snapshot({ now: BID_OPEN, buckets: [bucket()] });
    // #when
    const bid = plan(s, pricing, PRICE).find((a) => a.kind === "bid");
    // #then
    const premium = premiumFor(s, pricing, PRICE, 0, CALL_STRIKE);
    assert.deepEqual(bid, {
      kind: "bid",
      quote: {
        series: 11n,
        premium,
        maxFeeBps: 0,
        maxAmount: 5n * ONE,
        minFill: LOT,
        deadline: OCT_09,
      },
    });
  });

  it("bids only what its USDG covers, fee included", () => {
    // #given: a put, so exercising it takes NVDA, and USDG for a token and a half of premium
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s0 = snapshot({ now: BID_OPEN, buckets: [put] });
    const premium = premiumFor(s0, pricing, PRICE, 1, PUT_STRIKE) ?? 0n;
    const s = snapshot({ now: BID_OPEN, buckets: [put], usdgBalance: premium + premium / 2n });
    // #when
    const bid = plan(s, pricing, PRICE).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 150n * LOT);
  });

  it("keeps back the strike it would pay to exercise the calls it bids for", () => {
    // #given: USDG for two tokens' premium plus two tokens at the strike, and a little over
    const s0 = snapshot({ now: BID_OPEN, buckets: [bucket()] });
    const premium = premiumFor(s0, pricing, PRICE, 0, CALL_STRIKE) ?? 0n;
    const usdgBalance = 2n * (premium + CALL_STRIKE) + 1000n;
    const s = snapshot({ now: BID_OPEN, buckets: [bucket()], usdgBalance });
    // #when
    const bid = plan(s, pricing, PRICE).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 2n * ONE);
  });

  it("bids on puts only as far as it holds the NVDA to deliver", () => {
    // #given
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s = snapshot({ now: BID_OPEN, buckets: [put], assetBalance: ONE + ONE / 2n });
    // #when
    const bid = plan(s, pricing, PRICE).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 150n * LOT);
  });

  it("keeps back what its open longs and its own pending bids will take to exercise", () => {
    // #given: a call long still to expire, its own bid on a put bucket, and a fresh call bucket
    const s0 = snapshot({ now: BID_OPEN, buckets: [bucket()] });
    const premium = premiumFor(s0, pricing, PRICE, 0, CALL_STRIKE) ?? 0n;
    const held: Holding = {
      series: 5n,
      side: 0,
      strike: CALL_STRIKE,
      expiry: OCT_09,
      windowEnd: OCT_09 + 7200,
      balance: ONE,
    };
    const pending = bucket({
      side: 1,
      strike: PUT_STRIKE,
      series: 12n,
      bestBidder: MAKER,
      ownBid: { premium: 3_000_000n, amount: 2n * ONE },
    });
    const s = snapshot({
      now: BID_OPEN,
      buckets: [pending, bucket()],
      holdings: [held],
      // The long's strike, the pending bid's premium, and one token of the new call.
      usdgBalance: CALL_STRIKE + 6_000_000n + premium + CALL_STRIKE + 1000n,
      assetBalance: 2n * ONE,
    });
    // #when
    const bid = plan(s, pricing, PRICE).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, ONE);
  });

  it("exercises an in-the-money call in its window and leaves an out-of-the-money one", () => {
    // #given: spot 250 against strikes 245 and 255
    const holdings: Holding[] = [
      {
        series: 1n,
        side: 0,
        strike: 245_000_000n,
        expiry: OCT_02,
        windowEnd: OCT_02 + 7200,
        balance: ONE,
      },
      {
        series: 2n,
        side: 0,
        strike: 255_000_000n,
        expiry: OCT_02,
        windowEnd: OCT_02 + 7200,
        balance: ONE,
      },
    ];
    const s = snapshot({ now: OCT_02 + 600, price: answered(250n), holdings });
    // #when
    const actions = plan(s, pricing, PRICE).filter((a) => a.kind === "exercise");
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 1n, amount: ONE }]);
  });

  it("exercises only as many put lots as the NVDA it holds", () => {
    // #given
    const holdings: Holding[] = [
      {
        series: 3n,
        side: 1,
        strike: 230_000_000n,
        expiry: OCT_02,
        windowEnd: OCT_02 + 7200,
        balance: ONE,
      },
    ];
    const s = snapshot({
      now: OCT_02 + 600,
      price: answered(220n),
      holdings,
      assetBalance: ONE / 4n + 1n,
    });
    // #when
    const actions = plan(s, pricing, PRICE).filter((a) => a.kind === "exercise");
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 3n, amount: ONE / 4n }]);
  });

  it("quotes a new mid-week order whose minimum its price meets", () => {
    // #given
    const idle: IdleOrder[] = [
      { id: 7n, side: 0, target: CALL_STRIKE, minPremium: 100n, size: ONE, frozen: false },
      { id: 8n, side: 0, target: CALL_STRIKE, minPremium: 10n ** 12n, size: ONE, frozen: false },
    ];
    const s = snapshot({ buckets: [bucket()], idle });
    // #when
    const fills = plan(s, pricing, PRICE).filter((a) => a.kind === "fill");
    // #then
    assert.deepEqual(
      fills.map((f) => [f.orderId, f.quote.maxAmount]),
      [[7n, ONE]],
    );
  });

  it("doesn't quote frozen orders or with quoting off", () => {
    // #given
    const order: IdleOrder = {
      id: 7n,
      side: 0,
      target: CALL_STRIKE,
      minPremium: 0n,
      size: ONE,
      frozen: true,
    };
    // #when
    const frozen = plan(snapshot({ buckets: [bucket()], idle: [order] }), pricing, PRICE);
    const off = plan(
      snapshot({ buckets: [bucket()], idle: [{ ...order, frozen: false }] }),
      { ...pricing, rfq: false },
      PRICE,
    );
    // #then
    assert.deepEqual([frozen, off], [[], []]);
  });

  it("registers, bids and quotes nothing while the price is unusable", () => {
    // #given: a bid window with one bucket to bid on and one to register, and a mid-week order
    const bidding = snapshot({
      now: BID_OPEN,
      buckets: [bucket(), bucket({ side: 1, strike: PUT_STRIKE, series: 12n, registered: false })],
    });
    const quoting = snapshot({
      buckets: [bucket()],
      idle: [{ id: 7n, side: 0, target: CALL_STRIKE, minPremium: 100n, size: ONE, frozen: false }],
    });
    // #when
    const actions = [plan(bidding, pricing, STAND_DOWN), plan(quoting, pricing, STAND_DOWN)];
    // #then
    assert.deepEqual(actions, [[], []]);
  });

  it("still approves, withdraws and exercises while the oracle is paused", () => {
    // #given: an in-the-money call in its window, USDG to claim and an allowance to top up
    const holdings: Holding[] = [
      {
        series: 1n,
        side: 0,
        strike: CALL_STRIKE,
        expiry: OCT_02,
        windowEnd: OCT_02 + 7200,
        balance: ONE,
      },
    ];
    const s = snapshot({
      now: OCT_02 + 600,
      price: { ...answered(250n), oraclePaused: { ok: true, value: true } },
      holdings,
      usdgAllowance: 0n,
      claimableUsdg: 1_000_000n,
    });
    // #when
    const actions = plan(s, pricing, STAND_DOWN);
    // #then
    assert.deepEqual(kinds(actions), ["approve", "withdraw", "exercise"]);
  });

  it("doesn't exercise without a readable, positive answer to judge the money on", () => {
    // #given: an in-the-money call in its window, once with a zero answer, once with no answer
    const holdings: Holding[] = [
      {
        series: 1n,
        side: 0,
        strike: CALL_STRIKE,
        expiry: OCT_02,
        windowEnd: OCT_02 + 7200,
        balance: ONE,
      },
    ];
    const zero = snapshot({ now: OCT_02 + 600, price: answered(0n), holdings });
    const unread = snapshot({
      now: OCT_02 + 600,
      price: { ...answered(250n), round: { ok: false, error: "HttpRequestError: timed out" } },
      holdings,
    });
    // #when
    const actions = [plan(zero, pricing, STAND_DOWN), plan(unread, pricing, STAND_DOWN)];
    // #then
    assert.deepEqual(actions, [[], []]);
  });
});
