import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTicket } from "../src/ticket.ts";
import type { Epoch } from "../src/week.ts";

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
