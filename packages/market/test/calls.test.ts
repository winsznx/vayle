import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import { decodeFunctionData, getAddress } from "viem";
import {
  cancelOrder,
  nextStep,
  placeOrder,
  withdraw,
  withGasMargin,
  type OrderState,
  type SeriesState,
} from "../src/index.ts";

const MARKET = getAddress("0x00000000000000000000000000000000000000aa");
const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");

function order(overrides: Partial<OrderState> = {}): OrderState {
  return {
    id: 1n,
    owner: MARKET,
    asset: NVDA,
    side: 0,
    status: "active",
    target: 245_000_000n,
    minPremium: 1000n,
    flip: false,
    flipTarget: 0n,
    size: 10n ** 18n,
    committed: 0n,
    series: 0n,
    frozen: false,
    ...overrides,
  };
}

const series: SeriesState = {
  id: 9n,
  side: 0,
  strike: 245_000_000n,
  expiry: 1_791_576_000n,
  windowEnd: 1_791_583_200n,
  settled: false,
};

describe("calls", () => {
  it("address the market and decode back to the same arguments", () => {
    // #given
    const params = {
      asset: NVDA,
      side: 0,
      target: 245_000_000n,
      minPremium: 1000n,
      size: 10n ** 18n,
      flip: true,
      flipTarget: 230_000_000n,
    } as const;
    // #when
    const call = placeOrder(MARKET, params);
    const decoded = decodeFunctionData({ abi: vayleMarketAbi, data: call.data });
    // #then
    assert.deepEqual(
      [call.to, decoded.functionName, decoded.args],
      [MARKET, "placeOrder", [params]],
    );
  });

  it("encode exits with the market's own selectors", () => {
    // #when
    const names = [cancelOrder(MARKET, 1n), withdraw(MARKET, NVDA, 5n)].map(
      (c) => decodeFunctionData({ abi: vayleMarketAbi, data: c.data }).functionName,
    );
    // #then
    assert.deepEqual(names, ["cancelOrder", "withdraw"]);
  });
});

describe("nextStep", () => {
  it("settles an order whose series has settled", () => {
    // #then
    assert.equal(nextStep(order({ series: 9n }), { ...series, settled: true }, 0n), "settle");
  });

  it("finalizes first once the window has ended", () => {
    // #then
    assert.equal(nextStep(order({ series: 9n }), series, series.windowEnd), "finalize-then-settle");
  });

  it("waits while the order is frozen in a batch", () => {
    // #then
    assert.equal(nextStep(order({ frozen: true }), null, 0n), "wait");
  });

  it("can cancel an idle active order", () => {
    // #then
    assert.equal(nextStep(order(), null, 0n), "cancel");
  });

  it("can stop an attached order renewing while its week runs", () => {
    // #then
    assert.equal(nextStep(order({ series: 9n }), series, 0n), "stop-renewing");
  });

  it("waits on an attached order that has already stopped renewing", () => {
    // #then
    assert.equal(nextStep(order({ series: 9n, status: "cancelled" }), series, 0n), "wait");
  });
});

describe("withGasMargin", () => {
  it("leaves room for a gap record and a quarter more over the estimate", () => {
    // #given
    const estimate = 142_786n;
    // #when
    const limit = withGasMargin(estimate);
    // #then
    assert.equal(limit, 142_786n + 35_696n + 100_000n);
  });
});
