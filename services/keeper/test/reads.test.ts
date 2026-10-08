import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionCalendarAbi, stockTokenRegistryAbi, vayleMarketAbi } from "@vayle/abi";
import { markets, type Market } from "@vayle/markets";
import { parseAbi, type Address } from "viem";
import { keeperClients } from "../src/clients.ts";
import { loadConfig } from "../src/config.ts";
import { readSnapshot } from "../src/snapshot.ts";
import { byAddress, fakeChain, Revert, type FakeContract } from "./rpc.ts";

const MARKET: Address = "0x00000000000000000000000000000000000000aa";
const LIVENESS: Address = "0x00000000000000000000000000000000000000bb";
const CALENDAR: Address = "0x00000000000000000000000000000000000000cc";
const REGISTRY: Address = "0x00000000000000000000000000000000000000dd";
const OWNER: Address = "0x00000000000000000000000000000000000000ee";
// The Oct 9 close is the schedule's first, and the market deployed the Thursday before.
const OCT_09 = 1_791_576_000;
const OCT_16 = OCT_09 + 7 * 86_400;
const DEPLOYED = OCT_09 - 30 * 3600;
const PHASE_1 = 1n << 64n;

const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);
const revertAbi = parseAbi(["error Error(string)"]);

function nvda(): Market {
  const found = markets.find((m) => m.symbol === "NVDA");
  assert.ok(found, "the markets file lists NVDA");
  return found;
}

// A second market built from NVDA's, with its own token and feed.
function second(): Market {
  return {
    ...nvda(),
    symbol: "TWO",
    token: "0x00000000000000000000000000000000000000A1",
    feed: "0x00000000000000000000000000000000000000A2",
  };
}

interface World {
  readonly now: number;
  // A feed that reverts every read, and a token the registry lists with another strike tick.
  readonly brokenFeed?: Address;
  readonly relisted?: Address;
  // Each market's latest expiry, 0 before its first week.
  readonly latestExpiry: number;
  readonly opening: number;
  readonly batchDeadline: number;
  // One idle sell order per market at $245.
  readonly orders: boolean;
}

function contracts(listed: readonly Market[], world: World): Map<string, FakeContract> {
  const boundaries = [OCT_09, OCT_16].map((close) => ({
    close: BigInt(close),
    creationDeadline: BigInt(close + 2 * 86_400 + 17 * 3600 + 1800),
  }));
  const orders = world.orders
    ? listed.map((m) => ({
        owner: OWNER,
        asset: m.token,
        side: 0,
        status: 1,
        flip: false,
        target: 245_000_000n,
        minPremium: 0n,
        flipTarget: 0n,
        rawUnit: m.rawUnit,
        lot: m.lot,
        size: 10n ** 18n,
        committed: 0n,
        series: 0n,
      }))
    : [];
  const market: FakeContract = {
    abi: vayleMarketAbi,
    read: (name, args) => {
      switch (name) {
        case "LIVENESS_LOOKBACK":
          return 1800n;
        case "BID_WINDOW":
          return 7200n;
        case "deployedAt":
          return BigInt(DEPLOYED);
        case "orderCount":
          return BigInt(orders.length);
        case "latestExpiry":
          return BigInt(world.latestExpiry);
        case "epoch":
          return {
            opening: BigInt(world.opening),
            expiry: BigInt(world.latestExpiry),
            batchDeadline: BigInt(world.batchDeadline),
            windowLength: 7200,
            referenceUpdatedAt: BigInt(world.opening - 60),
            referenceRound: PHASE_1 | 1188n,
            referencePrice: 237_000_000n,
            rawUnit: 10n ** 18n,
            lot: 10n ** 16n,
            priceTick: 100n,
            strikeTick: 5_000_000n,
            strikeRangeBps: 1000,
          };
        case "orderOf":
          return orders[Number(args[0]) - 1];
        case "isListedStrike":
          return true;
        case "bestBid":
          return { maker: OWNER, premium: 2_500_000n, amount: 10n ** 18n, maxFeeBps: 0 };
        case "batchOf":
          return {
            phase: 0,
            feeBps: 0,
            maxOrderId: 0n,
            total: 0n,
            counted: 0n,
            eligible: 0n,
            capacity: 0n,
            processed: 0n,
            written: 0n,
            escrow: 0n,
            cursor: 0n,
          };
        case "attachedOrders":
          return 0n;
        default:
          throw new Error(`unexpected market read ${name}`);
      }
    },
  };
  const calendar: FakeContract = {
    abi: sessionCalendarAbi,
    read: (name, args) => {
      const t = args[0] as bigint;
      if (name === "latestBoundaryAtOrBefore") {
        const behind = boundaries.filter((b) => b.close <= t);
        return behind.at(-1) ?? new Revert(sessionCalendarAbi, "NoCloseAtOrBefore", [t]);
      }
      if (name === "nextCloseAfter") {
        return (
          boundaries.find((b) => b.close > t)?.close ??
          new Revert(sessionCalendarAbi, "NoCloseAfter", [t])
        );
      }
      throw new Error(`unexpected calendar read ${name}`);
    },
  };
  const registry: FakeContract = {
    abi: stockTokenRegistryAbi,
    read: (_name, args) => {
      const m = listed.find((l) => l.token.toLowerCase() === String(args[0]).toLowerCase());
      if (m === undefined) throw new Error("unexpected token");
      return {
        uid: m.uid,
        feed: m.feed,
        decimals: m.decimals,
        feedDecimals: m.feedDecimals,
        rawUnit: m.rawUnit,
        lot: m.lot,
        priceTick: m.priceTick,
        strikeTick: m.token === world.relisted ? m.strikeTick * 2n : m.strikeTick,
        strikeRangeBps: m.strikeRangeBps,
        listed: true,
      };
    },
  };
  // Ten rounds an hour apart, the last landing ten minutes after the Oct 9 close.
  const latest = PHASE_1 | 1200n;
  const landed = (id: bigint): bigint => BigInt(OCT_09 + 600) - (latest - id) * 3600n;
  const feed: FakeContract = {
    abi: feedAbi,
    read: (name, args) => {
      const id = name === "latestRoundData" ? latest : (args[0] as bigint);
      return [id, 23_700_000_000n, landed(id), landed(id), id];
    },
  };
  // A feed whose every read reverts.
  const broken: FakeContract = {
    abi: feedAbi,
    read: () => new Revert(revertAbi, "Error", ["No data present"]),
  };
  return byAddress([
    [MARKET, market],
    [CALENDAR, calendar],
    [REGISTRY, registry],
    ...listed.map((m) => [m.feed, m.feed === world.brokenFeed ? broken : feed] as const),
  ]);
}

async function read(listed: readonly Market[], world: World) {
  const chain = fakeChain({ number: 82_900_000n, timestamp: world.now }, contracts(listed, world));
  const config = loadConfig(
    {
      KEEPER_KEY: `0x${"11".repeat(32)}`,
      ROBINHOOD_RPC_URL: "https://rpc.invalid",
      VAYLE_MARKET: MARKET,
      VAYLE_LIVENESS: LIVENESS,
      VAYLE_CALENDAR: CALENDAR,
      VAYLE_REGISTRY: REGISTRY,
    },
    listed,
  );
  const result = await readSnapshot(keeperClients(config, chain.fetchFn).public, config);
  return { ...result, requests: chain.requests.length };
}

// How many requests one snapshot read takes.
async function requestsFor(listed: readonly Market[], world: World): Promise<number> {
  return (await read(listed, world)).requests;
}

async function oneAndTwo(world: World): Promise<[number, number]> {
  return [await requestsFor([nvda()], world), await requestsFor([nvda(), second()], world)];
}

const FIRST_WEEK = { latestExpiry: 0, opening: 0, batchDeadline: 0, orders: false };
const OPEN_WEEK = {
  latestExpiry: OCT_16,
  opening: OCT_09,
  batchDeadline: OCT_09 + 2 * 86_400 + 4 * 3600,
  orders: false,
};

describe("requests per snapshot", () => {
  it("are two before the first week can open, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ ...FIRST_WEEK, now: DEPLOYED + 600 });
    // #then
    assert.deepEqual(counts, [2, 2]);
  });

  it("are three while the first week waits to open, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ ...FIRST_WEEK, now: DEPLOYED + 3600 });
    // #then
    assert.deepEqual(counts, [3, 3]);
  });

  it("are three mid-week, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ ...OPEN_WEEK, now: OCT_09 + 3 * 86_400 });
    // #then
    assert.deepEqual(counts, [3, 3]);
  });

  it("are seven after a close with weeks due and orders on the book, for one market or two", async () => {
    // #given: the Oct 9 close passed 20 minutes ago and the first weeks expired at it
    const world = {
      latestExpiry: OCT_09,
      opening: DEPLOYED + 1800,
      batchDeadline: DEPLOYED + 1800,
      orders: true,
      now: OCT_09 + 1200,
    };
    // #when
    const counts = await oneAndTwo(world);
    // #then: the block, the first call, the epochs, the feeds' latest rounds beside the order book,
    // the round window, then the series and buckets
    assert.deepEqual(counts, [7, 7]);
  });
});

// The Oct 9 close passed 20 minutes ago and the first weeks expired at it.
const AFTER_FIRST_CLOSE = {
  latestExpiry: OCT_09,
  opening: DEPLOYED + 1800,
  batchDeadline: DEPLOYED + 1800,
  orders: true,
  now: OCT_09 + 1200,
};

describe("readSnapshot with one bad market", () => {
  it("leaves out a market the registry lists differently and reads the other", async () => {
    // #given
    const world = { ...AFTER_FIRST_CLOSE, relisted: second().token };
    // #when
    const { snapshot, notes } = await read([nvda(), second()], world);
    // #then
    assert.deepEqual(
      [snapshot.markets.map((m) => m.asset), notes],
      [
        [nvda().token],
        [
          {
            symbol: "TWO",
            text: "skipped this run: strikeTick is 10000000 in the registry and 5000000 in the markets file",
          },
        ],
      ],
    );
  });

  it("leaves a market whose feed reverts without a hint and finds the other's", async () => {
    // #given
    const world = { ...AFTER_FIRST_CLOSE, brokenFeed: second().feed };
    // #when
    const { snapshot, notes } = await read([nvda(), second()], world);
    // #then
    assert.deepEqual(
      [snapshot.markets.map((m) => m.roundHint), notes.map((n) => n.symbol)],
      [[PHASE_1 | 1199n, null], ["TWO"]],
    );
  });

  it("leaves out the orders of a market it skips", async () => {
    // #given
    const world = { ...AFTER_FIRST_CLOSE, relisted: second().token };
    // #when
    const { snapshot } = await read([nvda(), second()], world);
    // #then
    assert.deepEqual(
      snapshot.orders?.map((o) => o.asset),
      [nvda().token],
    );
  });
});
