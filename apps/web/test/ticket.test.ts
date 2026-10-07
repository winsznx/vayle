import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capProblem, checkTicket, roomUnderCaps } from "../src/app/ticket.ts";
import type { Epoch } from "../src/app/week.ts";

const epoch: Epoch = {
  opening: 0,
  expiry: 1,
  batchDeadline: 1,
  windowLength: 0,
  referencePrice: 238_410_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
  priceTick: 100n,
  lot: 10n ** 16n,
  rawUnit: 10n ** 18n,
};
const ONE = 10n ** 18n;
const balances = { asset: 2n * ONE, usdg: 300_000_000n };

describe("checkTicket", () => {
  it("accepts a sell order the wallet can cover and locks the NVDA", () => {
    // #when
    const result = checkTicket(
      { side: "sell", strike: 245_000_000n, amount: "1.50", minPremium: "0.25" },
      epoch,
      balances,
      6,
      18,
    );
    // #then
    assert.deepEqual(result, {
      ok: true,
      ticket: {
        size: 1_500_000_000_000_000_000n,
        minPremium: 250_000n,
        collateral: 1_500_000_000_000_000_000n,
      },
    });
  });

  it("locks the strike's value in USDG for a buy order", () => {
    // #when
    const result = checkTicket(
      { side: "buy", strike: 230_000_000n, amount: "1", minPremium: "" },
      epoch,
      balances,
      6,
      18,
    );
    // #then
    assert.ok(result.ok && result.ticket.collateral === 230_000_000n);
  });

  it("refuses amounts that aren't whole 0.01 lots", () => {
    // #when
    const result = checkTicket(
      { side: "sell", strike: 245_000_000n, amount: "0.005", minPremium: "0" },
      epoch,
      balances,
      6,
      18,
    );
    // #then
    assert.deepEqual(result, { ok: false, problem: "Amounts go in steps of 0.01 NVDA." });
  });

  it("refuses an order the wallet can't cover", () => {
    // #when
    const result = checkTicket(
      { side: "buy", strike: 230_000_000n, amount: "2", minPremium: "0" },
      epoch,
      balances,
      6,
      18,
    );
    // #then
    assert.equal(result.ok, false);
  });
});

describe("roomUnderCaps", () => {
  const caps = { openSize: 10n * ONE, walletSize: 3n * ONE, seriesOpenInterest: 0n, fillSize: 0n };

  it("is what's left of the wallet's share when that's tighter than the market's", () => {
    // #when
    const room = roomUnderCaps(caps, 4n * ONE, ONE);
    // #then
    assert.equal(room, 2n * ONE);
  });

  it("is what's left of the market's total when that's tighter", () => {
    // #when
    const room = roomUnderCaps(caps, 9n * ONE, 0n);
    // #then
    assert.equal(room, ONE);
  });

  it("is never below zero after a cap is lowered under what's open", () => {
    // #when
    const room = roomUnderCaps(caps, 12n * ONE, 0n);
    // #then
    assert.equal(room, 0n);
  });
});

describe("capProblem", () => {
  const caps = { openSize: 10n * ONE, walletSize: 3n * ONE, seriesOpenInterest: 0n, fillSize: 0n };

  it("says buy orders aren't open while their cap is zero", () => {
    // #when
    const problem = capProblem(ONE, 0n, { ...caps, openSize: 0n }, "buy", "NVDA", 18);
    // #then
    assert.equal(problem, "Buy orders aren't open yet.");
  });

  it("says how much fits when an order is over the room left", () => {
    // #when
    const problem = capProblem(2n * ONE, ONE / 2n, caps, "sell", "NVDA", 18);
    // #then
    assert.equal(problem, "That's over the market's limit for now. Up to 0.50 NVDA fits.");
  });

  it("finds nothing wrong with an order that fits", () => {
    // #when
    const problem = capProblem(ONE, ONE, caps, "sell", "NVDA", 18);
    // #then
    assert.equal(problem, null);
  });
});
