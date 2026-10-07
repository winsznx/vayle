import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderSummary, type StoredEvent, type Week } from "../src/summary.ts";

const DAY = 86_400;
// Four weekly openings, Fridays 16:00 ET.
const W1 = 1_789_761_600;
const weeks: Week[] = [0, 1, 2, 3].map((k) => ({
  opening: W1 + k * 7 * DAY,
  expiry: W1 + (k + 1) * 7 * DAY,
}));

function event(name: string, order: string, extra: Partial<StoredEvent> = {}): StoredEvent {
  return {
    block_number: 1,
    log_index: 0,
    tx_hash: "0x",
    block_time: new Date((W1 - DAY) * 1000).toISOString(),
    name,
    order_id: order,
    series: null,
    account: null,
    args: {},
    ...extra,
  };
}

function fill(order: string, series: string, premium: string): StoredEvent {
  return event("BatchFilled", order, { series, args: { premiumValue: premium } });
}

// Series 1 expires at the end of week 1, series 2 at the end of week 2.
const expiries = new Map([
  ["1", weeks[0]?.expiry ?? 0],
  ["2", weeks[1]?.expiry ?? 0],
]);
// After week 4's batch deadline.
const NOW = W1 + 3 * 7 * DAY + 4 * DAY;

describe("orderSummary", () => {
  it("adds up premium and counts the weeks that filled", () => {
    // #given
    const events = [
      event("OrderPlaced", "5"),
      fill("5", "1", "2500000"),
      fill("5", "2", "1250000"),
    ];
    // #when
    const summary = orderSummary("5", events, weeks, expiries, NOW);
    // #then
    assert.deepEqual(
      [summary.premiumEarned, summary.weeksFilled, summary.state],
      ["3750000", 2, "active"],
    );
  });

  it("counts the weeks in a row without a fill since the last one", () => {
    // #given: filled in weeks 1 and 2, nothing in weeks 3 and 4
    const events = [event("OrderPlaced", "5"), fill("5", "1", "1"), fill("5", "2", "1")];
    // #when
    const summary = orderSummary("5", events, weeks, expiries, NOW);
    // #then
    assert.equal(summary.skipStreak, 2);
  });

  it("doesn't count a week the order joined after its batch had run", () => {
    // #given: placed on the Wednesday of week 3, never filled
    const placed = event("OrderPlaced", "6", {
      block_time: new Date((W1 + 2 * 7 * DAY + 5 * DAY) * 1000).toISOString(),
    });
    // #when
    const summary = orderSummary("6", [placed], weeks, expiries, NOW);
    // #then: only week 4 counts
    assert.equal(summary.skipStreak, 1);
  });

  it("shows no streak for an order that isn't active", () => {
    // #given
    const events = [event("OrderPlaced", "5"), event("OrderCancelled", "5")];
    // #when
    const summary = orderSummary("5", events, weeks, expiries, NOW);
    // #then
    assert.deepEqual([summary.state, summary.skipStreak], ["cancelled", 0]);
  });
});
