import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionCalendarAbi, vayleMarketAbi } from "@vayle/abi";
import { createPublicClient, custom, encodeErrorResult, getAddress, type Hex } from "viem";
import { observeClose } from "@vayle/market";
import { refusalOf, refusalText } from "../src/refusals.ts";

const MARKET = getAddress("0x00000000000000000000000000000000000000aa");
const OWNER = getAddress("0x00000000000000000000000000000000000000bb");
const NVDA = getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC");
// Fri Oct 9 2026 16:00 EDT, and the market's LIVENESS_LOOKBACK.
const CLOSE = 1_791_576_000n;
const LOOKBACK = 1800n;

const notNearAClose = encodeErrorResult({
  abi: vayleMarketAbi,
  errorName: "NotNearAClose",
  args: [CLOSE],
});

// A wallet or node that answers every call and estimate with `error`, the way providers reject.
// Retries would only repeat the same rejection.
function rejecting(error: Error) {
  return createPublicClient({
    transport: custom(
      {
        request: ({ method }: { readonly method: string }) =>
          Promise.reject(
            method === "eth_estimateGas" || method === "eth_call"
              ? error
              : new Error(`unexpected ${method}`),
          ),
      },
      { retryCount: 0 },
    ),
  });
}

// What the page's send() catches when the estimate for an observation reverts.
async function estimateFailure(error: Error): Promise<unknown> {
  const call = observeClose(MARKET, NVDA);
  return rejecting(error)
    .estimateGas({ account: OWNER, to: call.to, data: call.data })
    .then(
      () => null,
      (failure: unknown) => failure,
    );
}

function nodeRevert(data: Hex): Error {
  return Object.assign(new Error("execution reverted"), { code: 3, data });
}

describe("refusalOf", () => {
  it("reads a refused observation out of an estimate the way a node reports it", async () => {
    // #given
    const failure = await estimateFailure(nodeRevert(notNearAClose));
    // #when
    const refusal = refusalOf(failure);
    // #then
    assert.deepEqual(refusal, { name: "NotNearAClose", args: [CLOSE] });
  });

  it("finds the revert when a wallet wraps the node's error in its own", async () => {
    // #given
    const wrapped = Object.assign(new Error("Internal JSON-RPC error."), {
      code: -32603,
      data: { code: 3, message: "execution reverted", data: notNearAClose },
    });
    const failure = await estimateFailure(wrapped);
    // #when
    const refusal = refusalOf(failure);
    // #then
    assert.equal(refusal?.name, "NotNearAClose");
  });

  it("reads the calendar's refusals, which the market passes through", async () => {
    // #given
    const data = encodeErrorResult({
      abi: sessionCalendarAbi,
      errorName: "NoCloseAfter",
      args: [CLOSE],
    });
    const failure = await estimateFailure(nodeRevert(data));
    // #when
    const refusal = refusalOf(failure);
    // #then
    assert.deepEqual(refusal, { name: "NoCloseAfter", args: [CLOSE] });
  });

  it("reads a refused read too, so the schedule can treat an expected one as nothing", async () => {
    // #given
    const data = encodeErrorResult({
      abi: vayleMarketAbi,
      errorName: "UnknownEpoch",
      args: [NVDA, CLOSE],
    });
    const failure = await rejecting(nodeRevert(data))
      .readContract({
        address: MARKET,
        abi: vayleMarketAbi,
        functionName: "epoch",
        args: [NVDA, CLOSE],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // #when
    const refusal = refusalOf(failure);
    // #then
    assert.deepEqual(refusal, { name: "UnknownEpoch", args: [NVDA, CLOSE] });
  });

  it("finds nothing in a request the wallet rejected, or data no Vayle contract sends", async () => {
    // #given
    const rejected = await estimateFailure(
      Object.assign(new Error("User rejected the request."), { code: 4001 }),
    );
    const foreign = await estimateFailure(nodeRevert("0xdeadbeef"));
    // #when
    const refusals = [refusalOf(rejected), refusalOf(foreign)];
    // #then
    assert.deepEqual(refusals, [null, null]);
  });

  it("decodes an error without arguments as an empty list", async () => {
    // #given
    const data = encodeErrorResult({ abi: vayleMarketAbi, errorName: "NotHalted" });
    const failure = await estimateFailure(nodeRevert(data));
    // #when
    const refusal = refusalOf(failure);
    // #then
    assert.deepEqual(refusal, { name: "NotHalted", args: [] });
  });
});

describe("refusalText", () => {
  it("says when the market takes an observation, from the close it refused for", () => {
    // #when
    const text = refusalText({ name: "NotNearAClose", args: [CLOSE] }, LOOKBACK);
    // #then
    assert.equal(
      text,
      "The market takes a close observation only in the 30 minutes before a close. The next close is Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC), so it takes one from Fri, Oct 9, 2026, 15:30 EDT (2026-10-09 19:30 UTC).",
    );
  });

  it("says plainly what the other refusals of an observation mean", () => {
    // #when
    const texts = [
      refusalText({ name: "NoCloseAfter", args: [CLOSE] }, LOOKBACK),
      refusalText({ name: "NotListed", args: [NVDA] }, LOOKBACK),
      refusalText({ name: "NotAStockToken", args: [NVDA] }, LOOKBACK),
    ];
    // #then
    assert.deepEqual(texts, [
      "The market's calendar has no close after Fri, Oct 9, 2026, 16:00 EDT (2026-10-09 20:00 UTC), so there's no close to observe until more weeks are added.",
      `The market doesn't list ${NVDA}, so it has no close to observe.`,
      `The market couldn't read whether ${NVDA} has its price feed paused, so it can't record an observation.`,
    ]);
  });

  it("names any other refusal with its arguments", () => {
    // #when
    const text = refusalText({ name: "MarketHalted", args: [CLOSE] }, LOOKBACK);
    // #then
    assert.equal(text, "The market refused it with MarketHalted(1791576000).");
  });
});
