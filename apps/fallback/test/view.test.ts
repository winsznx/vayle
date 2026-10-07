import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cancelOrder, settleOrder, type OrderState, type SeriesState } from "@vayle/market";
import { amount, calldata, checkExercise, moment, orderLine, type Position } from "../src/view.ts";

const ONE = 10n ** 18n;
// Fri Oct 9 2026 16:00 EDT, and its exercise window's end.
const EXPIRY = 1_791_576_000n;
const WINDOW_END = EXPIRY + 7200n;
const MARKET = "0x0000000000000000000000000000000000000001";
const units = { assetSymbol: "NVDA", assetDecimals: 18, usdgDecimals: 6 };

function order(overrides: Partial<OrderState> = {}): OrderState {
  return {
    id: 4n,
    owner: "0x00000000000000000000000000000000000000bb",
    asset: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    side: 0,
    status: "active",
    target: 245_000_000n,
    minPremium: 0n,
    flip: false,
    flipTarget: 0n,
    size: ONE,
    committed: 0n,
    series: 0n,
    frozen: false,
    ...overrides,
  };
}

function series(overrides: Partial<SeriesState> = {}): SeriesState {
  return {
    id: 9n,
    side: 0,
    strike: 245_000_000n,
    expiry: EXPIRY,
    windowEnd: WINDOW_END,
    settled: false,
    ...overrides,
  };
}

function position(overrides: Partial<SeriesState> = {}, balance = 2n * ONE): Position {
  return { series: series(overrides), balance, lot: ONE / 100n, rawUnit: ONE };
}

describe("amounts and times", () => {
  it("shows amounts exactly, however small", () => {
    // #then
    assert.deepEqual(
      [amount(1n, 6, "USDG"), amount(1_500_000_000_000_000_000n, 18, "NVDA")],
      ["0.000001 USDG", "1.5 NVDA"],
    );
  });

  it("shows a chain time in New York time and in UTC", () => {
    // #then
    assert.equal(moment(EXPIRY), "Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC)");
  });
});

describe("orderLine", () => {
  it("offers to cancel an idle order", () => {
    // #when
    const line = orderLine(order(), null, EXPIRY - 86_400n, units);
    // #then
    assert.deepEqual(
      [line.what, line.state, line.step],
      ["Sell 1 NVDA at 245 USDG per token", "Active, waiting for a week to fill it.", "cancel"],
    );
  });

  it("names a closed order without the amount it no longer holds", () => {
    // #when
    const line = orderLine(order({ status: "closed", size: 0n }), null, EXPIRY, units);
    // #then
    assert.deepEqual(
      [line.what, line.state, line.step],
      ["Sell NVDA at 245 USDG per token", "Closed.", "none"],
    );
  });

  it("asks to finalize first when the window is over and nobody has", () => {
    // #when
    const line = orderLine(order({ series: 9n, committed: ONE }), series(), WINDOW_END + 1n, units);
    // #then
    assert.equal(line.step, "finalize-then-settle");
  });

  it("says when an attached order's window ends", () => {
    // #when
    const line = orderLine(order({ series: 9n, committed: ONE }), series(), EXPIRY + 60n, units);
    // #then
    assert.equal(
      line.state,
      "1 NVDA is in series 9, which expires Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC). Its exercise window ends Fri, Oct 9, 2026, 18:00 EDT (2026-10-09 22:00 UTC). The series isn't finalized yet. It renews after it settles unless you stop it.",
    );
  });

  it("offers to stop an attached order renewing while its week runs", () => {
    // #when
    const line = orderLine(order({ series: 9n, committed: ONE }), series(), EXPIRY - 3600n, units);
    // #then
    assert.equal(line.step, "stop-renewing");
  });

  it("says an attached order that was stopped won't renew", () => {
    // #when
    const line = orderLine(
      order({ series: 9n, committed: ONE, status: "cancelled" }),
      series(),
      EXPIRY - 3600n,
      units,
    );
    // #then
    assert.deepEqual(
      [line.step, line.state.endsWith("It won't renew after it settles.")],
      ["wait", true],
    );
  });
});

describe("orderLine with a window held open", () => {
  it("waits, and says why, when finalize would still find the window open", () => {
    // #given
    const held = {
      until: WINDOW_END + 3600n,
      quietSince: EXPIRY - 600n,
      latest: WINDOW_END + 86_400n,
    };
    // #when
    const line = orderLine(
      order({ series: 9n, committed: ONE }),
      series(),
      WINDOW_END + 60n,
      units,
      held,
    );
    // #then
    assert.deepEqual(
      [line.step, line.state],
      [
        "wait",
        "1 NVDA is in series 9, which expired Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC). Its exercise window is still open, until at least Fri, Oct 9, 2026, 19:00 EDT (2026-10-09 23:00 UTC). Nobody has checkpointed the chain since Fri, Oct 9, 2026, 15:50 EDT (2026-10-09 19:50 UTC), and quiet time keeps a window open, up to a day in total. It closes by Sat, Oct 10, 2026, 18:00 EDT (2026-10-10 22:00 UTC) at the latest.",
      ],
    );
  });
});

describe("checkExercise", () => {
  it("prices a call's exercise as the strike's value in USDG", () => {
    // #when
    const check = checkExercise(position(), "1.5", EXPIRY + 60n, units);
    // #then
    assert.deepEqual(check, {
      ok: true,
      amount: 1_500_000_000_000_000_000n,
      strikeValue: 367_500_000n,
      pays: { token: "usdg", amount: 367_500_000n },
    });
  });

  it("has a put's exercise deliver the asset", () => {
    // #when
    const check = checkExercise(position({ side: 1 }), "1", EXPIRY + 60n, units);
    // #then
    assert.deepEqual(check.ok && check.pays, { token: "asset", amount: ONE });
  });

  it("refuses before the window opens, after it closes, off the lot, or past the balance", () => {
    // #when
    const problems = [
      checkExercise(position(), "1", EXPIRY - 1n, units),
      checkExercise(position(), "1", WINDOW_END, units),
      checkExercise(position(), "0.005", EXPIRY + 60n, units),
      checkExercise(position(), "3", EXPIRY + 60n, units),
    ].map((check) => (check.ok ? null : check.problem));
    // #then
    assert.deepEqual(problems, [
      "The exercise window opens Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC).",
      "The exercise window has closed.",
      "Amounts go in steps of 0.01 NVDA.",
      "That's more than this account holds in the series.",
    ]);
  });
});

describe("calldata", () => {
  it("numbers the calls when there's more than one, in the order to send them", () => {
    // #given
    const calls = [cancelOrder(MARKET, 4n), settleOrder(MARKET, 4n)];
    // #when
    const text = calldata(calls);
    // #then
    assert.equal(
      text,
      `1. to: ${MARKET}\ndata: ${calls[0]?.data ?? ""}\n\n2. to: ${MARKET}\ndata: ${calls[1]?.data ?? ""}`,
    );
  });
});
