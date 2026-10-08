import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  plan,
  premiumFor,
  type EpochTerms,
  type MakerAction,
  type MakerSnapshot,
} from "../src/plan.ts";
import {
  answered,
  bucket,
  BID_OPEN,
  CALL_STRIKE,
  dollars,
  holding,
  idleOrder,
  LOT,
  MAKER,
  NVDA,
  nvda,
  OCT_02,
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
  USDG,
  WEEK,
} from "./fixtures.ts";

// Ten minutes into the Oct 2 close's window, with NVDA at `nowUsd` and its close at `closeUsd`.
function inWindow(
  closeUsd: bigint,
  nowUsd: bigint,
  overrides: Partial<MakerSnapshot> = {},
): MakerSnapshot {
  return snapshot({
    now: OCT_02 + 600,
    markets: [state({ price: answered(nowUsd), closes: new Map([[OCT_02, dollars(closeUsd)]]) })],
    ...overrides,
  });
}

function kinds(actions: readonly MakerAction[]): string[] {
  return actions.map((a) => a.kind);
}

function exercised(actions: readonly MakerAction[]): MakerAction[] {
  return actions.filter((a) => a.kind === "exercise");
}

describe("maker plan", () => {
  it("does nothing on a quiet Wednesday", () => {
    // #when
    const actions = plan(snapshot(), pricing, prices());
    // #then
    assert.deepEqual(actions, []);
  });

  it("approves and withdraws before anything else", () => {
    // #given
    const s = snapshot({ usdgAllowance: 0n, markets: [state({ claimable: ONE })] });
    // #when
    const actions = plan(s, pricing, prices());
    // #then
    assert.deepEqual(actions, [
      { kind: "approve", token: USDG },
      { kind: "withdraw", token: NVDA, amount: ONE },
    ]);
  });

  it("approves and withdraws each market's token", () => {
    // #given
    const s = snapshot({
      markets: [
        state({ allowance: 0n }),
        state({ market: other(), allowance: 0n, claimable: ONE }),
      ],
    });
    // #when
    const actions = plan(s, pricing, prices([NVDA, PRICE], [OTHER, PRICE]));
    // #then
    assert.deepEqual(actions, [
      { kind: "approve", token: NVDA },
      { kind: "approve", token: OTHER },
      { kind: "withdraw", token: OTHER, amount: ONE },
    ]);
  });

  it("bids into each bucket with orders once the bid window opens, registering a series first", () => {
    // #given
    const s = snapshot({
      now: BID_OPEN,
      markets: [
        state({
          buckets: [
            bucket(),
            bucket({ side: 1, strike: PUT_STRIKE, series: 12n, registered: false }),
          ],
        }),
      ],
      idle: [idleOrder(7n), idleOrder(8n, { side: 1, target: PUT_STRIKE })],
    });
    // #when
    const actions = plan(s, pricing, prices());
    // #then
    assert.deepEqual(kinds(actions), ["bid", "register"]);
  });

  it("doesn't bid in a bucket with no orders waiting", () => {
    // #given
    const s = snapshot({ now: BID_OPEN, markets: [state({ buckets: [bucket()] })] });
    // #when
    const actions = plan(s, pricing, prices());
    // #then
    assert.deepEqual(actions, []);
  });

  it("doesn't bid again in a bucket where it's already the best bidder", () => {
    // #given
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [bucket({ bestBidder: MAKER })] })],
      idle: [idleOrder(7n)],
    });
    // #when
    const actions = plan(s, pricing, prices());
    // #then
    assert.deepEqual(actions, []);
  });

  it("bids at the priced premium, for at most the series open interest the markets file sets", () => {
    // #given
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [bucket()] })],
      idle: [idleOrder(7n)],
    });
    const m = s.markets[0] ?? state();
    // #when
    const bid = plan(s, pricing, prices()).find((a) => a.kind === "bid");
    // #then
    assert.deepEqual(bid, {
      kind: "bid",
      quote: {
        series: 11n,
        premium: premiumFor(s, m, pricing, PRICE, 0, CALL_STRIKE),
        maxFeeBps: 0,
        maxAmount: nvda().sell.caps.seriesOpenInterest,
        minFill: LOT,
        deadline: OCT_09,
      },
    });
  });

  it("prices each market with its own volatility from the markets file", () => {
    // #given: two markets alike but for their volatility
    const s = snapshot();
    const calm = state({ market: other({ maker: { ...nvda().maker, volBps: 2000 } }) });
    const wild = state({ market: other({ maker: { ...nvda().maker, volBps: 8000 } }) });
    // #when
    const premiums = [calm, wild].map((m) => premiumFor(s, m, pricing, PRICE, 0, CALL_STRIKE));
    // #then
    assert.ok((premiums[0] ?? 0n) < (premiums[1] ?? 0n));
  });

  it("bids only what its USDG covers, fee included", () => {
    // #given: a put, so exercising it takes NVDA, and USDG for a token and a half of premium
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s0 = snapshot({ now: BID_OPEN, markets: [state({ buckets: [put] })] });
    const premium = premiumFor(s0, state(), pricing, PRICE, 1, PUT_STRIKE) ?? 0n;
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [put] })],
      idle: [idleOrder(7n, { side: 1, target: PUT_STRIKE })],
      usdgBalance: premium + premium / 2n,
    });
    // #when
    const bid = plan(s, pricing, prices()).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 150n * LOT);
  });

  it("keeps back the strike it would pay to exercise the calls it bids for", () => {
    // #given: USDG for two tokens' premium plus two tokens at the strike, and a little over
    const atOpen = snapshot({ now: BID_OPEN });
    const premium = premiumFor(atOpen, state(), pricing, PRICE, 0, CALL_STRIKE) ?? 0n;
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [bucket()] })],
      idle: [idleOrder(7n)],
      usdgBalance: 2n * (premium + CALL_STRIKE) + 1000n,
    });
    // #when
    const bid = plan(s, pricing, prices()).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 2n * ONE);
  });

  it("bids on puts only as far as it holds the token to deliver", () => {
    // #given
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [put], balance: ONE + ONE / 2n })],
      idle: [idleOrder(7n, { side: 1, target: PUT_STRIKE })],
    });
    // #when
    const bid = plan(s, pricing, prices()).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 150n * LOT);
  });

  it("counts the token the market holds for it toward puts, less what its puts keep back", () => {
    // #given: 1 NVDA in the wallet, 0.5 to withdraw, and a 0.25 NVDA put long still to expire
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [put], balance: ONE, claimable: ONE / 2n })],
      idle: [idleOrder(7n, { side: 1, target: PUT_STRIKE })],
      holdings: [
        holding({
          series: 5n,
          side: 1,
          strike: PUT_STRIKE,
          expiry: OCT_09,
          windowEnd: OCT_09 + 7200,
          balance: ONE / 4n,
        }),
      ],
    });
    // #when
    const bid = plan(s, pricing, prices()).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, 125n * LOT);
  });

  it("keeps back the token for its own put bids that a batch may still write", () => {
    // #given: 2 NVDA, its own pending bid for 1.5 on one put, and a second put bucket to bid on
    const pending = bucket({
      side: 1,
      strike: PUT_STRIKE,
      series: 12n,
      bestBidder: MAKER,
      ownBid: { premium: 1_000_000n, amount: ONE + ONE / 2n },
    });
    const next = bucket({ side: 1, strike: 225_000_000n, series: 13n });
    const s = snapshot({
      now: BID_OPEN,
      markets: [state({ buckets: [pending, next], balance: 2n * ONE })],
      idle: [idleOrder(7n, { side: 1, target: 225_000_000n })],
    });
    // #when
    const bid = plan(s, pricing, prices()).find((a) => a.kind === "bid");
    // #then
    assert.equal(bid?.quote.maxAmount, ONE / 2n);
  });

  it("doesn't size one market's puts on another market's token", () => {
    // #given: 3 NVDA and none of the other token
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s = snapshot({
      now: BID_OPEN,
      markets: [
        state({ balance: 3n * ONE }),
        state({ market: other(), buckets: [put], balance: 0n }),
      ],
      idle: [idleOrder(7n, { asset: OTHER, side: 1, target: PUT_STRIKE })],
    });
    // #when
    const actions = plan(s, pricing, prices([NVDA, PRICE], [OTHER, PRICE]));
    // #then
    assert.deepEqual(actions, []);
  });

  it("keeps back what open longs in any market and its own pending bids take to exercise", () => {
    // #given: a call long in the other market still to expire, its own bid on a put, and a fresh
    // call bucket
    const atOpen = snapshot({ now: BID_OPEN });
    const premium = premiumFor(atOpen, state(), pricing, PRICE, 0, CALL_STRIKE) ?? 0n;
    const pending = bucket({
      side: 1,
      strike: PUT_STRIKE,
      series: 12n,
      bestBidder: MAKER,
      ownBid: { premium: 3_000_000n, amount: 2n * ONE },
    });
    const s = snapshot({
      now: BID_OPEN,
      markets: [
        state({ buckets: [pending, bucket()], balance: 2n * ONE }),
        state({ market: other() }),
      ],
      idle: [idleOrder(7n)],
      holdings: [holding({ series: 5n, asset: OTHER, expiry: OCT_09, windowEnd: OCT_09 + 7200 })],
      // The long's strike, the pending bid's premium, and one token of the new call.
      usdgBalance: CALL_STRIKE + 6_000_000n + premium + CALL_STRIKE + 1000n,
    });
    // #when
    const bid = plan(s, pricing, prices([NVDA, PRICE], [OTHER, PRICE])).find(
      (a) => a.kind === "bid",
    );
    // #then
    assert.equal(bid?.quote.maxAmount, ONE);
  });

  it("neither bids nor quotes nor registers on a side the markets file disables", () => {
    // #given: buy targets off, with a put bucket in the bid window and a put order mid-week
    const sellOnly = other({ buy: { enabled: false, caps: { ...nvda().buy.caps } } });
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n, registered: false });
    const order = idleOrder(7n, { asset: OTHER, side: 1, target: PUT_STRIKE });
    const bidding = snapshot({
      now: BID_OPEN,
      markets: [state({ market: sellOnly, buckets: [put] })],
      idle: [order],
    });
    const quoted = snapshot({
      markets: [state({ market: sellOnly, buckets: [{ ...put, registered: true }] })],
      idle: [order],
    });
    // #when
    const actions = [bidding, quoted].map((s) => plan(s, pricing, prices([OTHER, PRICE])));
    // #then
    assert.deepEqual(actions, [[], []]);
  });

  it("quotes a new mid-week order whose minimum its price meets", () => {
    // #given
    const idle = [idleOrder(7n), idleOrder(8n, { minPremium: 10n ** 12n })];
    const s = snapshot({ markets: [state({ buckets: [bucket()] })], idle });
    // #when
    const fills = plan(s, pricing, prices()).filter((a) => a.kind === "fill");
    // #then
    assert.deepEqual(
      fills.map((f) => [f.orderId, f.quote.maxAmount]),
      [[7n, ONE]],
    );
  });

  it("quotes no more than the series open interest the markets file sets", () => {
    // #given: a series with room for 10 NVDA on the chain, a file cap of 6, fills of up to 8
    const s = snapshot({
      markets: [state({ buckets: [bucket({ fillSize: 8n * ONE, seriesRoom: 10n * ONE })] })],
      idle: [idleOrder(7n, { size: 9n * ONE })],
    });
    // #when
    const fill = plan(s, pricing, prices()).find((a) => a.kind === "fill");
    // #then
    assert.equal(fill?.quote.maxAmount, nvda().sell.caps.seriesOpenInterest);
  });

  it("counts what the series has written against the markets file's open interest", () => {
    // #given: 5 NVDA written in a series the file caps at 6, with room for more on the chain
    const s = snapshot({
      markets: [state({ buckets: [bucket({ written: 5n * ONE, seriesRoom: 10n * ONE })] })],
      idle: [idleOrder(7n, { size: 2n * ONE })],
    });
    // #when
    const fill = plan(s, pricing, prices()).find((a) => a.kind === "fill");
    // #then
    assert.equal(fill?.quote.maxAmount, ONE);
  });

  it("quotes a buy target only as far as the token it holds covers", () => {
    // #given: 0.4 NVDA in the wallet and 0.1 to withdraw, against a 1 NVDA buy order
    const put = bucket({ side: 1, strike: PUT_STRIKE, series: 12n });
    const s = snapshot({
      markets: [state({ buckets: [put], balance: (4n * ONE) / 10n, claimable: ONE / 10n })],
      idle: [idleOrder(7n, { side: 1, target: PUT_STRIKE })],
    });
    // #when
    const fill = plan(s, pricing, prices()).find((a) => a.kind === "fill");
    // #then
    assert.equal(fill?.quote.maxAmount, ONE / 2n);
  });

  it("doesn't quote frozen orders or with quoting off", () => {
    // #given
    const order = idleOrder(7n, { minPremium: 0n, frozen: true });
    // #when
    const frozen = plan(
      snapshot({ markets: [state({ buckets: [bucket()] })], idle: [order] }),
      pricing,
      prices(),
    );
    const off = plan(
      snapshot({ markets: [state({ buckets: [bucket()] })], idle: [{ ...order, frozen: false }] }),
      { ...pricing, rfq: false },
      prices(),
    );
    // #then
    assert.deepEqual([frozen, off], [[], []]);
  });

  it("registers, bids and quotes nothing while the price is unusable", () => {
    // #given: a bid window with one bucket to bid on and one to register, and a mid-week order
    const bidding = snapshot({
      now: BID_OPEN,
      markets: [
        state({
          buckets: [
            bucket(),
            bucket({ side: 1, strike: PUT_STRIKE, series: 12n, registered: false }),
          ],
        }),
      ],
      idle: [idleOrder(7n), idleOrder(8n, { side: 1, target: PUT_STRIKE })],
    });
    const quoting = snapshot({
      markets: [state({ buckets: [bucket()] })],
      idle: [idleOrder(7n)],
    });
    const down = prices([NVDA, STOOD_DOWN]);
    // #when
    const actions = [plan(bidding, pricing, down), plan(quoting, pricing, down)];
    // #then
    assert.deepEqual(actions, [[], []]);
  });

  it("keeps bidding in one market while another stands down", () => {
    // #given
    const s = snapshot({
      now: BID_OPEN,
      markets: [
        state({ buckets: [bucket()] }),
        state({ market: other(), buckets: [bucket({ series: 21n })] }),
      ],
      idle: [idleOrder(7n), idleOrder(8n, { asset: OTHER })],
    });
    // #when
    const bids = plan(s, pricing, prices([NVDA, STOOD_DOWN], [OTHER, PRICE])).filter(
      (a) => a.kind === "bid",
    );
    // #then
    assert.deepEqual(
      bids.map((b) => b.quote.series),
      [21n],
    );
  });
});

describe("maker plan in a market's first week", () => {
  // The first week opened Thursday Oct 8 at 10:30 ET and runs to the Oct 9 close. Its batch deadline
  // is its opening, so it has no bid window and quotes from the start.
  const OPENED = OCT_09 - 29 * 3600 - 1800;
  const FIRST: EpochTerms = { ...WEEK, opening: OPENED, batchDeadline: OPENED, expiry: OCT_09 };

  it("quotes an order right after the week opens", () => {
    // #given
    const s = snapshot({
      now: OPENED + 60,
      markets: [state({ epoch: FIRST, buckets: [bucket()] })],
      idle: [idleOrder(7n)],
    });
    // #when
    const fills = plan(s, pricing, prices()).filter((a) => a.kind === "fill");
    // #then
    assert.deepEqual(
      fills.map((f) => [f.orderId, f.quote.series, f.quote.maxAmount]),
      [[7n, 11n, ONE]],
    );
  });

  it("registers the series an order needs first, then quotes it on the next run", () => {
    // #given
    const unregistered = snapshot({
      now: OPENED + 60,
      markets: [state({ epoch: FIRST, buckets: [bucket({ registered: false })] })],
      idle: [idleOrder(7n), idleOrder(8n)],
    });
    // #when
    const actions = plan(unregistered, pricing, prices());
    // #then
    assert.deepEqual(actions, [
      { kind: "register", asset: NVDA, side: 0, strike: CALL_STRIKE, expiry: OCT_09 },
    ]);
  });

  it("doesn't bid, since the week has no bid window", () => {
    // #given: two hours after the opening, where a regular week's bid window would be
    const s = snapshot({
      now: OPENED + 7200,
      markets: [state({ epoch: FIRST, buckets: [bucket()] })],
      idle: [idleOrder(7n)],
    });
    // #when
    const actions = plan(s, pricing, prices());
    // #then
    assert.deepEqual(kinds(actions), ["fill"]);
  });
});

describe("maker exercise", () => {
  it("exercises a call that closed in the money though it's out of the money now", () => {
    // #given: the $245 call closed at $250, and NVDA trades at $240 in the window
    const s = inWindow(250n, 240n, { holdings: [holding()] });
    // #when
    const actions = exercised(plan(s, pricing, prices()));
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 1n, amount: ONE }]);
  });

  it("doesn't exercise a call that closed out of the money though it's in the money now", () => {
    // #given: the $245 call closed at $240, and NVDA trades at $250 in the window
    const s = inWindow(240n, 250n, { holdings: [holding()] });
    // #when
    const actions = exercised(plan(s, pricing, prices()));
    // #then
    assert.deepEqual(actions, []);
  });

  it("exercises a put that closed in the money though it's out of the money now", () => {
    // #given: the $230 put closed at $225, and NVDA trades at $240 in the window
    const s = inWindow(225n, 240n, {
      holdings: [holding({ side: 1, strike: PUT_STRIKE })],
    });
    // #when
    const actions = exercised(plan(s, pricing, prices()));
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 1n, amount: ONE }]);
  });

  it("doesn't exercise a put that closed out of the money though it's in the money now", () => {
    // #given: the $230 put closed at $235, and NVDA trades at $225 in the window
    const s = inWindow(235n, 225n, {
      holdings: [holding({ side: 1, strike: PUT_STRIKE })],
    });
    // #when
    const actions = exercised(plan(s, pricing, prices()));
    // #then
    assert.deepEqual(actions, []);
  });

  it("doesn't exercise a target the close only reached", () => {
    // #given: a $245 call and a $230 put, with NVDA closing exactly on each
    const call = inWindow(245n, 260n, { holdings: [holding()] });
    const put = inWindow(230n, 210n, { holdings: [holding({ side: 1, strike: PUT_STRIKE })] });
    // #when
    const actions = [call, put].map((s) => exercised(plan(s, pricing, prices())));
    // #then
    assert.deepEqual(actions, [[], []]);
  });

  it("exercises calls only as far as its USDG pays the strike", () => {
    // #given: USDG for the strike of 0.4 NVDA and a little over
    const s = inWindow(250n, 250n, {
      holdings: [holding()],
      usdgBalance: (CALL_STRIKE * 4n) / 10n + 1n,
    });
    // #when
    const actions = exercised(plan(s, pricing, prices()));
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 1n, amount: (4n * ONE) / 10n }]);
  });

  it("exercises only as many put lots as the token it holds", () => {
    // #given
    const s = inWindow(220n, 220n, {
      holdings: [holding({ series: 3n, side: 1, strike: PUT_STRIKE })],
    });
    const short = {
      ...s,
      markets: s.markets.map((m) => ({ ...m, balance: ONE / 4n + 1n })),
    };
    // #when
    const actions = exercised(plan(short, pricing, prices()));
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 3n, amount: ONE / 4n }]);
  });

  it("judges each market's longs by its own close", () => {
    // #given: $245 calls in both markets, NVDA closing at $250 and the other at $240
    const s = snapshot({
      now: OCT_02 + 600,
      markets: [
        state({ closes: new Map([[OCT_02, dollars(250n)]]) }),
        state({ market: other(), closes: new Map([[OCT_02, dollars(240n)]]) }),
      ],
      holdings: [holding(), holding({ series: 2n, asset: OTHER })],
    });
    // #when
    const actions = exercised(plan(s, pricing, prices([NVDA, PRICE], [OTHER, PRICE])));
    // #then
    assert.deepEqual(actions, [{ kind: "exercise", series: 1n, amount: ONE }]);
  });

  it("still approves, withdraws and exercises while the oracle is paused", () => {
    // #given: an in-the-money call in its window, USDG to claim and an allowance to top up
    const s = inWindow(250n, 250n, {
      holdings: [holding()],
      usdgAllowance: 0n,
      claimableUsdg: 1_000_000n,
    });
    // #when
    const actions = plan(s, pricing, prices([NVDA, STOOD_DOWN]));
    // #then
    assert.deepEqual(kinds(actions), ["approve", "withdraw", "exercise"]);
  });

  it("doesn't exercise without a positive close and the feed's decimals to judge it by", () => {
    // #given: an in-the-money call in its window, with no close found, a zero close, and the
    // feed's decimals unread
    const unfound = snapshot({
      now: OCT_02 + 600,
      markets: [state({ closes: new Map([[OCT_02, null]]) })],
      holdings: [holding()],
    });
    const zero = inWindow(0n, 250n, { holdings: [holding()] });
    const undecided = snapshot({
      now: OCT_02 + 600,
      markets: [
        state({
          price: {
            ...answered(250n),
            feedDecimals: { ok: false, error: "HttpRequestError: timed out" },
          },
          closes: new Map([[OCT_02, dollars(250n)]]),
        }),
      ],
      holdings: [holding()],
    });
    // #when
    const actions = [unfound, zero, undecided].map((s) =>
      exercised(plan(s, pricing, prices([NVDA, STOOD_DOWN]))),
    );
    // #then
    assert.deepEqual(actions, [[], [], []]);
  });
});
