import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionCalendarAbi, stockTokenRegistryAbi } from "@vayle/abi";
import { markets, type Listing, type Market } from "@vayle/markets";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  HttpRequestError,
} from "viem";
import { loadConfig } from "../src/config.ts";
import {
  AFTER_BATCH_DEADLINE,
  bucketSeries,
  listingProblem,
  noneOnRevert,
  ORDERS_AFTER_CLOSE,
  ordersReadUntil,
} from "../src/snapshot.ts";

function nvda(): Market {
  const found = markets.find((m) => m.symbol === "NVDA");
  assert.ok(found, "the markets file lists NVDA");
  return found;
}

// NVDA's listing as the registry would hold it after the deploy listed it from the file.
function listingOf(m: Market, overrides: Partial<Listing> = {}): Listing {
  return {
    uid: m.uid,
    feed: m.feed,
    decimals: m.decimals,
    feedDecimals: m.feedDecimals,
    rawUnit: m.rawUnit,
    lot: m.lot,
    priceTick: m.priceTick,
    strikeTick: m.strikeTick,
    strikeRangeBps: m.strikeRangeBps,
    listed: true,
    ...overrides,
  };
}

// A registry read that reverted with `errorName`, wrapped the way viem rejects a batched read.
function registryReverted(errorName: "NotListed" | "OwnableUnauthorizedAccount"): Error {
  const cause = new ContractFunctionRevertedError({
    abi: stockTokenRegistryAbi,
    data: encodeErrorResult({
      abi: stockTokenRegistryAbi,
      errorName,
      args: ["0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
    }),
    functionName: "asset",
  });
  return new ContractFunctionExecutionError(cause, {
    abi: stockTokenRegistryAbi,
    args: ["0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
    functionName: "asset",
  });
}

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

// A calendar read that reverted, wrapped the way viem rejects a read, from a Multicall3 call or
// its own. Null data is a revert with nothing to decode, which is how an inner call that ran out of
// gas comes back.
function reverted(errorName: "NoCloseAtOrBefore" | "NoCloseAfter" | null): Error {
  const data =
    errorName === null
      ? "0x"
      : encodeErrorResult({ abi: sessionCalendarAbi, errorName, args: [1_791_576_000n] });
  const cause = new ContractFunctionRevertedError({
    abi: sessionCalendarAbi,
    data,
    functionName: "latestBoundaryAtOrBefore",
  });
  return new ContractFunctionExecutionError(cause, {
    abi: sessionCalendarAbi,
    args: [1_791_576_000n],
    functionName: "latestBoundaryAtOrBefore",
  });
}

describe("noneOnRevert", () => {
  it("reads the calendar's own revert as no close", () => {
    // #when
    const answer = noneOnRevert("NoCloseAtOrBefore")(reverted("NoCloseAtOrBefore"));
    // #then
    assert.equal(answer, null);
  });

  it("throws a revert with another name", () => {
    // #when
    const answer = (): null => noneOnRevert("NoCloseAtOrBefore")(reverted("NoCloseAfter"));
    // #then
    assert.throws(answer, ContractFunctionExecutionError);
  });

  it("throws a revert with no data, as an inner call out of gas returns", () => {
    // #when
    const answer = (): null => noneOnRevert("NoCloseAfter")(reverted(null));
    // #then
    assert.throws(answer, ContractFunctionExecutionError);
  });

  it("throws a failed call", () => {
    // #given
    const failed = new HttpRequestError({ url: "https://rpc.invalid", status: 502 });
    // #when
    const answer = (): null => noneOnRevert("NoCloseAfter")(failed);
    // #then
    assert.throws(answer, HttpRequestError);
  });
});

describe("bucketSeries", () => {
  it("gives the IDs the market's seriesFor returned on a local fork", () => {
    // #given: the week opened at the Oct 9 close, a $245 sell bucket and a $235 buy bucket
    const config = loadConfig({
      KEEPER_KEY: `0x${"11".repeat(32)}`,
      ROBINHOOD_RPC_URL: "http://127.0.0.1:8545",
      VAYLE_MARKET: "0x0000000000000000000000000000000000000001",
      VAYLE_LIVENESS: "0x0000000000000000000000000000000000000002",
      VAYLE_CALENDAR: "0x0000000000000000000000000000000000000003",
      VAYLE_REGISTRY: "0x0000000000000000000000000000000000000004",
    });
    const epoch = {
      opening: 1_791_576_000,
      expiry: 1_792_180_800,
      batchDeadline: 1_791_763_200,
      windowLength: 7_200,
    };
    // #when
    const asset = nvda().token;
    const ids = [
      bucketSeries(config, asset, epoch, 0, 245_000_000n),
      bucketSeries(config, asset, epoch, 1, 235_000_000n),
    ];
    // #then: what an eth_call of seriesFor returned for the same terms
    assert.deepEqual(ids, [
      6730551042281658524990364716284180930003331497979158362436015311512157505391n,
      73160825792504066013936851552564191733528385210324865546998918809348944395051n,
    ]);
  });
});

describe("listingProblem", () => {
  it("passes a market listed as the file states it", async () => {
    // #when
    const problem = await listingProblem(nvda(), Promise.resolve(listingOf(nvda())));
    // #then
    assert.equal(problem, null);
  });

  it("names the fields of a listing that differs", async () => {
    // #given
    const listing = listingOf(nvda(), { feed: "0x0000000000000000000000000000000000000Fee" });
    // #when
    const problem = await listingProblem(nvda(), Promise.resolve(listing));
    // #then
    assert.equal(
      problem,
      `feed is 0x0000000000000000000000000000000000000FEE in the registry and ${nvda().feed} in the markets file`,
    );
  });

  it("says when the registry doesn't list the market", async () => {
    // #when
    const problem = await listingProblem(nvda(), Promise.reject(registryReverted("NotListed")));
    // #then
    assert.equal(problem, "it isn't listed in the token registry");
  });

  it("pins another revert on the market", async () => {
    // #when
    const problem = await listingProblem(
      nvda(),
      Promise.reject(registryReverted("OwnableUnauthorizedAccount")),
    );
    // #then
    assert.match(problem ?? "", /^its listing couldn't be read: ContractFunctionExecutionError/);
  });

  it("throws a failed request, which no one market caused", async () => {
    // #given
    const failed = new HttpRequestError({ url: "https://rpc.invalid", status: 502 });
    // #when
    const problem = listingProblem(nvda(), Promise.reject(failed));
    // #then
    await assert.rejects(problem, HttpRequestError);
  });
});
