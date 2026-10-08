import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import type { OrderState } from "@vayle/market";
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { planEdit, type Holdings, type Limits } from "../src/app/edit.ts";
import type { Epoch } from "../src/app/week.ts";

const ONE = 10n ** 18n;
// A made-up market: the planner works the same for every listed Stock Token.
const addresses = {
  market: getAddress("0x00000000000000000000000000000000000000aa"),
  asset: getAddress("0x00000000000000000000000000000000000000cc"),
  usdg: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
};
const units = { usdg: 6, asset: { symbol: "ABC", decimals: 18, places: 2 } };
const caps = {
  openSize: 100n * ONE,
  walletSize: 10n * ONE,
  seriesOpenInterest: 0n,
  fillSize: 0n,
};
const limits: Limits = { caps: { sell: caps, buy: caps }, open: { sell: 0n, buy: 0n } };
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
  walletOpen: { sell: ONE / 2n, buy: 0n },
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
  it("moves an idle sell target to a new price and size, asking approval for the extra tokens", () => {
    // #when
    const plan = planEdit(
      order(),
      { target: 255_000_000n, amount: "1.00", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      limits,
      units,
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
      limits,
      units,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? functionNames(plan.calls) : plan, ["amendOrder"]);
  });

  it("frees USDG to withdraw when a buy target moves to a lower price", () => {
    // #given
    const buy = order({ side: 1, target: 230_000_000n, size: ONE });
    // #when
    const plan = planEdit(
      buy,
      { target: 225_000_000n, amount: "1.00", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      limits,
      units,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? [functionNames(plan.calls), plan.move] : plan, [
      ["amendOrder"],
      { direction: "frees", amount: 5_000_000n },
    ]);
  });

  it("counts what the target already locks toward a bigger target", () => {
    // #given the wallet holds 1 token and the target 0.5 more
    const input = { target: 250_000_000n, amount: "1.50", minimum: "0.10" };
    // #when
    const plan = planEdit(order(), input, epoch, holdings, addresses, limits, units);
    // #then
    assert.equal(plan.kind, "ready");
  });

  it("refuses more tokens than the wallet and the target hold together", () => {
    // #when
    const plan = planEdit(
      order(),
      { target: 250_000_000n, amount: "1.51", minimum: "0.10" },
      epoch,
      holdings,
      addresses,
      limits,
      units,
    );
    // #then
    assert.deepEqual(plan, {
      kind: "problem",
      problem: "That's more ABC than this wallet holds.",
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
      limits,
      units,
    );
    // #then
    assert.deepEqual(plan, { kind: "unchanged" });
  });

  it("changes only the least payment of a target in this week's trade", () => {
    // #given
    const attached = order({ series: 42n, committed: ONE / 2n });
    // #when
    const plan = planEdit(
      attached,
      { target: 255_000_000n, amount: "2.00", minimum: "0.25" },
      epoch,
      holdings,
      addresses,
      limits,
      units,
    );
    // #then
    assert.deepEqual(plan.kind === "ready" ? [functionNames(plan.calls), plan.move] : plan, [
      ["updateOrder"],
      null,
    ]);
  });

  it("counts the target's own size as released when it checks the wallet's cap", () => {
    // #given a wallet cap of 1 token, all of it this target's 0.5 and another target's 0.5
    const tight: Limits = {
      caps: { sell: { ...caps, walletSize: ONE }, buy: caps },
      open: { sell: ONE, buy: 0n },
    };
    const full = { ...holdings, walletOpen: { sell: ONE, buy: 0n } };
    // #when
    const plan = planEdit(
      order(),
      { target: 255_000_000n, amount: "0.50", minimum: "0.10" },
      epoch,
      full,
      addresses,
      tight,
      units,
    );
    // #then
    assert.equal(plan.kind, "ready");
  });

  it("refuses to grow a target past the wallet's cap", () => {
    // #given the same full cap
    const tight: Limits = {
      caps: { sell: { ...caps, walletSize: ONE }, buy: caps },
      open: { sell: ONE, buy: 0n },
    };
    const full = { ...holdings, walletOpen: { sell: ONE, buy: 0n } };
    // #when
    const plan = planEdit(
      order(),
      { target: 250_000_000n, amount: "0.75", minimum: "0.10" },
      epoch,
      full,
      addresses,
      tight,
      units,
    );
    // #then
    assert.deepEqual(plan, {
      kind: "problem",
      problem: "That's over the market's limit for now. Up to 0.50 ABC fits.",
    });
  });

  it("refuses a least payment off the market's price steps, naming the step", () => {
    // #given
    const attached = order({ series: 42n });
    // #when
    const plan = planEdit(
      attached,
      { target: 250_000_000n, amount: "0.50", minimum: "0.12345" },
      epoch,
      holdings,
      addresses,
      limits,
      units,
    );
    // #then
    assert.deepEqual(plan, {
      kind: "problem",
      problem: "The least payment goes in steps of $0.0001.",
    });
  });
});
