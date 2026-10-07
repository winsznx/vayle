import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import type { OrderState } from "@vayle/market";
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { planEdit, type Holdings } from "../src/app/edit.ts";
import type { Epoch } from "../src/app/week.ts";

const ONE = 10n ** 18n;
const addresses = {
  market: getAddress("0x00000000000000000000000000000000000000aa"),
  asset: getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
};
const decimals = { usdg: 6, asset: 18 };
const epoch: Epoch = {
  opening: 0,
  expiry: 1,
  batchDeadline: 1,
  windowLength: 0,
  referencePrice: 237_190_000n,
  strikeTick: 5_000_000n,
  strikeRangeBps: 1000,
  priceTick: 100n,
  lot: 10n ** 16n,
  rawUnit: ONE,
};
const holdings: Holdings = {
  balanceAsset: ONE,
  balanceUsdg: 500_000_000n,
  allowanceAsset: 0n,
  allowanceUsdg: 0n,
};

function order(overrides: Partial<OrderState> = {}): OrderState {
  return {
    id: 3n,
    owner: getAddress("0x00000000000000000000000000000000000000bb"),
    asset: addresses.asset,
    side: 0,
    status: "active",
    target: 250_000_000n,
    minPremium: 100_000n,
    flip: false,
    flipTarget: 0n,
    size: ONE / 2n,
    committed: 0n,
    series: 0n,
    frozen: false,
    ...overrides,
  };
}

function functionNames(calls: readonly { readonly data: Hex }[]): string[] {
  return calls.map((c) => {
    try {
      return decodeFunctionData({ abi: vayleMarketAbi, data: c.data }).functionName;
    } catch {
      return decodeFunctionData({ abi: erc20Abi, data: c.data }).functionName;
    }
  });
}

describe("planEdit", () => {
  it("moves an idle sell order to a new price and size, asking approval for the extra NVDA", () => {
    // #when
    const plan = planEdit(
      order(),
      { target: 255_000_000n, amount: "1.00", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      decimals,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? [functionNames(plan.calls), plan.move] : plan, [
      ["approve", "amendOrder"],
      { direction: "locks", amount: ONE / 2n },
    ]);
  });

  it("skips the approval when the allowance already covers the extra", () => {
    // #when
    const plan = planEdit(
      order(),
      { target: 255_000_000n, amount: "1.00", minimum: "0.10" },
      epoch,
      { ...holdings, allowanceAsset: ONE },
      addresses,
      decimals,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? functionNames(plan.calls) : plan, ["amendOrder"]);
  });

  it("frees USDG to withdraw when a buy order moves to a lower price", () => {
    // #given
    const buy = order({ side: 1, target: 230_000_000n, size: ONE });
    // #when
    const plan = planEdit(
      buy,
      { target: 225_000_000n, amount: "1.00", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      decimals,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? [functionNames(plan.calls), plan.move] : plan, [
      ["amendOrder"],
      { direction: "frees", amount: 5_000_000n },
    ]);
  });

  it("counts what the order already locks toward a bigger order", () => {
    // #given the wallet holds 1 NVDA and the order 0.5 more
    const input = { target: 250_000_000n, amount: "1.50", minimum: "0.10" };
    // #when
    const plan = planEdit(order(), input, epoch, holdings, addresses, decimals);
    // #then
    assert.equal(plan.kind, "ready");
  });

  it("refuses more NVDA than the wallet and the order hold together", () => {
    // #when
    const plan = planEdit(
      order(),
      { target: 250_000_000n, amount: "1.51", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      decimals,
    );
    // #then
    assert.deepEqual(plan, {
      kind: "problem",
      problem: "That's more NVDA than this wallet holds.",
    });
  });

  it("has nothing to send when the terms are the same", () => {
    // #when
    const plan = planEdit(
      order(),
      { target: 250_000_000n, amount: "0.50", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      decimals,
    );
    // #then
    assert.deepEqual(plan, { kind: "unchanged" });
  });

  it("changes only the least premium of an order in this week's trade", () => {
    // #given
    const attached = order({ series: 42n, committed: ONE / 2n });
    // #when
    const plan = planEdit(
      attached,
      { target: 255_000_000n, amount: "2.00", minimum: "0.25" },
      epoch,
      holdings,
      addresses,
      decimals,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? [functionNames(plan.calls), plan.move] : plan, [
      ["updateOrder"],
      null,
    ]);
  });

  it("refuses a least premium off the market's price steps", () => {
    // #given
    const attached = order({ series: 42n });
    // #when
    const plan = planEdit(
      attached,
      { target: 250_000_000n, amount: "0.50", minimum: "0.12345" },
      epoch,
      holdings,
      addresses,
      decimals,
    );
    // #then
    assert.equal(plan.kind, "problem");
  });
});
