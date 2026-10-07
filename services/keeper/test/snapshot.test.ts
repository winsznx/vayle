import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AFTER_BATCH_DEADLINE, ORDERS_AFTER_CLOSE, ordersReadUntil } from "../src/snapshot.ts";

// Thu Dec 24 2026, 13:00 ET (an early close), and Fri Dec 18 2026, 16:00 ET.
const THURSDAY_CLOSE = 1_798_135_200;
const FRIDAY_CLOSE = 1_797_627_600;

describe("ordersReadUntil", () => {
  it("reads three days after a Friday close, whose batch is done by then", () => {
    // #given: a batch deadline two days and four hours after the close
    const deadline = FRIDAY_CLOSE + 2 * 86_400 + 4 * 3_600;
    // #when
    const until = ordersReadUntil(FRIDAY_CLOSE, deadline);
    // #then
    assert.equal(until, FRIDAY_CLOSE + ORDERS_AFTER_CLOSE);
  });

  it("keeps reading past three days when a Thursday close's batch deadline falls later", () => {
    // #given: a batch deadline three days and seven hours after the close
    const deadline = THURSDAY_CLOSE + 3 * 86_400 + 7 * 3_600;
    // #when
    const until = ordersReadUntil(THURSDAY_CLOSE, deadline);
    // #then
    assert.equal(until, deadline + AFTER_BATCH_DEADLINE);
  });

  it("falls back to three days when the week's batch deadline isn't known", () => {
    // #when
    const until = ordersReadUntil(FRIDAY_CLOSE, null);
    // #then
    assert.equal(until, FRIDAY_CLOSE + ORDERS_AFTER_CLOSE);
  });
});
