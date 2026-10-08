import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stockTokenRegistryAbi, vayleMarketAbi } from "@vayle/abi";
import type { Market } from "@vayle/markets";
import { erc20Abi, parseAbi, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { makerClients } from "../src/clients.ts";
import { loadConfig } from "../src/config.ts";
import { readSnapshot } from "../src/snapshot.ts";
import { nvda, OCT_09, ONE, other } from "./fixtures.ts";
import { byAddress, fakeChain, Revert, type FakeContract } from "./rpc.ts";

const MARKET: Address = "0x00000000000000000000000000000000000000aa";
const REGISTRY: Address = "0x00000000000000000000000000000000000000dd";
const OWNER: Address = "0x00000000000000000000000000000000000000ee";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const KEY = `0x${"22".repeat(32)}` as const;
const MAKER = privateKeyToAddress(KEY);
const OCT_16 = OCT_09 + 7 * 86_400;
const PHASE_1 = 1n << 64n;
const NO_MAKER: Address = "0x0000000000000000000000000000000000000000";

const feedAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);
const tokenAbi = [...erc20Abi, ...parseAbi(["function oraclePaused() view returns (bool)"])];
const revertAbi = parseAbi(["error Error(string)"]);

interface World {
  readonly now: number;
  // Each market's week: the one from the Oct 9 close to the Oct 16 close.
  readonly epoch: boolean;
  // Each market has an idle sell at $245, and one written sell in a series the maker holds that
  // expired at the Oct 9 close.
  readonly orders: boolean;
  // A token whose every read reverts, and a token the registry lists with another strike tick.
  readonly brokenToken?: Address;
  readonly relisted?: Address;
}

function contracts(listed: readonly Market[], world: World): Map<string, FakeContract> {
  const held = (i: number): bigint => 1000n + BigInt(i);
  const orders = world.orders
    ? listed.flatMap((m, i) => [
        { asset: m.token, status: 1, series: 0n },
        { asset: m.token, status: 1, series: held(i) },
      ])
    : [];
  const market: FakeContract = {
    abi: vayleMarketAbi,
    read: (name, args) => {
      switch (name) {
        case "BID_WINDOW":
          return 7200n;
        case "feeBps":
          return 0;
        case "orderCount":
          return BigInt(orders.length);
        case "claimable":
          return 0n;
        case "latestExpiry":
          return world.epoch ? BigInt(OCT_16) : 0n;
        case "capsOf":
          return {
            openSize: 10n * ONE,
            walletSize: 4n * ONE,
            seriesOpenInterest: 6n * ONE,
            fillSize: 2n * ONE,
          };
        case "epoch":
          return {
            opening: BigInt(OCT_09),
            expiry: BigInt(OCT_16),
            batchDeadline: BigInt(OCT_09 + 2 * 86_400 + 4 * 3600),
            windowLength: 7200,
            referenceUpdatedAt: BigInt(OCT_09 - 60),
            referenceRound: PHASE_1 | 1199n,
            referencePrice: 237_000_000n,
            rawUnit: ONE,
            lot: 10n ** 16n,
            priceTick: 100n,
            strikeTick: 5_000_000n,
            strikeRangeBps: 1000,
          };
        case "orderOf": {
          const o = orders[Number(args[0]) - 1];
          if (o === undefined) throw new Error("no such order");
          return {
            owner: OWNER,
            asset: o.asset,
            side: 0,
            status: o.status,
            flip: false,
            target: 245_000_000n,
            minPremium: 0n,
            flipTarget: 0n,
            rawUnit: ONE,
            lot: 10n ** 16n,
            size: ONE,
            committed: o.series === 0n ? 0n : ONE,
            series: o.series,
          };
        }
        case "frozen":
          return false;
        case "seriesKey": {
          const i = listed.findIndex((_, j) => held(j) === args[0]);
          const m = listed[i];
          if (m === undefined) return new Revert(vayleMarketAbi, "UnknownSeries", [args[0]]);
          return {
            chainId: 4663n,
            asset: m.token,
            optionType: 0,
            strike: 245_000_000n,
            expiry: BigInt(OCT_09),
            windowLength: 7200,
            unitBasis: 1,
            exerciseStyle: 0,
            settlementType: 0,
            collateralToken: m.token,
            collateralMode: 0,
          };
        }
        case "bestBid":
          return { maker: NO_MAKER, premium: 0n, amount: 0n, maxFeeBps: 0 };
        case "poolOf":
          return {
            written: 0n,
            exercised: 0n,
            collateral: 0n,
            proceeds: 0n,
            remainingShares: 0n,
            settled: false,
          };
        case "balanceOf":
          return ONE;
        case "windowEnd":
          return BigInt(OCT_09 + 7200);
        default:
          throw new Error(`unexpected market read ${name}`);
      }
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
  const token = (address: Address): FakeContract => ({
    abi: tokenAbi,
    read: (name) => {
      if (address === world.brokenToken) return new Revert(revertAbi, "Error", ["broken"]);
      if (name === "balanceOf") return 5n * ONE;
      if (name === "allowance") return 1n << 200n;
      if (name === "oraclePaused") return false;
      throw new Error(`unexpected token read ${name}`);
    },
  });
  // Rounds an hour apart, the latest landing a minute before now.
  const latest = PHASE_1 | 1200n;
  const landed = (id: bigint): bigint => BigInt(world.now - 60) - (latest - id) * 3600n;
  const feed: FakeContract = {
    abi: feedAbi,
    read: (name, args) => {
      if (name === "decimals") return 8;
      const id = name === "latestRoundData" ? latest : (args[0] as bigint);
      return [id, 23_700_000_000n, landed(id), landed(id), id];
    },
  };
  return byAddress([
    [MARKET, market],
    [REGISTRY, registry],
    [USDG, token(USDG)],
    ...listed.flatMap((m) => [[m.token, token(m.token)] as const, [m.feed, feed] as const]),
  ]);
}

async function read(listed: readonly Market[], world: World, everyTarget = false) {
  const chain = fakeChain({ number: 82_900_000n, timestamp: world.now }, contracts(listed, world));
  const config = loadConfig(
    {
      MAKER_KEY: KEY,
      ROBINHOOD_RPC_URL: "https://rpc.invalid",
      VAYLE_MARKET: MARKET,
      VAYLE_REGISTRY: REGISTRY,
      MAKER_EDGE_BPS: "1000",
      MAKER_DIVIDEND_YIELD_BPS: "2",
      MAKER_RATE_BPS: "400",
      MAKER_RFQ: "on",
    },
    listed,
  );
  const client = makerClients(config, chain.fetchFn).public;
  const result = await readSnapshot(client, config, MAKER, { everyTarget });
  return { ...result, requests: chain.requests.length };
}

async function oneAndTwo(world: World, everyTarget = false): Promise<[number, number]> {
  return [
    (await read([nvda()], world, everyTarget)).requests,
    (await read([nvda(), other()], world, everyTarget)).requests,
  ];
}

// Wednesday Oct 14, mid-week.
const MID_WEEK = OCT_09 + 5 * 86_400;

describe("requests per snapshot", () => {
  it("are three mid-week with nothing on the book, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ now: MID_WEEK, epoch: true, orders: false });
    // #then
    assert.deepEqual(counts, [3, 3]);
  });

  it("are four with orders on the book, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ now: MID_WEEK, epoch: true, orders: true });
    // #then
    assert.deepEqual(counts, [4, 4]);
  });

  it("are five while a held series is in its window, the last for its close", async () => {
    // #given: ten minutes after the Oct 9 close
    const world = { now: OCT_09 + 600, epoch: true, orders: true };
    // #when
    const counts = await oneAndTwo(world);
    // #then
    assert.deepEqual(counts, [5, 5]);
  });

  it("are four for the bid sheet's every target, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ now: MID_WEEK, epoch: true, orders: false }, true);
    // #then
    assert.deepEqual(counts, [4, 4]);
  });
});

describe("readSnapshot", () => {
  it("reads every target the week lists for the bid sheet", async () => {
    // #when
    const { snapshot } = await read([nvda()], { now: MID_WEEK, epoch: true, orders: false }, true);
    // #then: $237 reference, $5 tick, 10% band
    assert.deepEqual(
      snapshot.markets[0]?.buckets.map((b) => [b.side, b.strike]),
      [
        [0, 240_000_000n],
        [0, 245_000_000n],
        [0, 250_000_000n],
        [0, 255_000_000n],
        [0, 260_000_000n],
        [1, 215_000_000n],
        [1, 220_000_000n],
        [1, 225_000_000n],
        [1, 230_000_000n],
        [1, 235_000_000n],
      ],
    );
  });

  it("reads each held series' close while its window is open", async () => {
    // #given: ten minutes after the Oct 9 close, the round before the latest landed before it
    const world = { now: OCT_09 + 600, epoch: true, orders: true };
    // #when
    const { snapshot } = await read([nvda(), other()], world);
    // #then
    assert.deepEqual(
      snapshot.markets.map((m) => [...m.closes]),
      [[[OCT_09, 23_700_000_000n]], [[OCT_09, 23_700_000_000n]]],
    );
  });
});

describe("readSnapshot with one bad market", () => {
  const world = { now: MID_WEEK, epoch: true, orders: true };

  it("leaves out a market the registry lists differently and reads the other", async () => {
    // #when
    const { snapshot, notes } = await read([nvda(), other()], { ...world, relisted: nvda().token });
    // #then
    assert.deepEqual(
      [snapshot.markets.map((m) => m.market.symbol), notes],
      [
        ["TWO"],
        [
          {
            symbol: "NVDA",
            text: "skipped this run: strikeTick is 10000000 in the registry and 5000000 in the markets file",
          },
        ],
      ],
    );
  });

  it("leaves out a market whose token refuses its reads and reads the other", async () => {
    // #when
    const { snapshot, notes } = await read([nvda(), other()], {
      ...world,
      brokenToken: other().token,
    });
    // #then
    assert.deepEqual(
      [snapshot.markets.map((m) => m.market.symbol), notes.map((n) => n.symbol)],
      [["NVDA"], ["TWO"]],
    );
  });

  it("leaves out the orders and holdings of a market it skips", async () => {
    // #when
    const { snapshot } = await read([nvda(), other()], { ...world, relisted: nvda().token });
    // #then
    assert.deepEqual(
      [snapshot.idle.map((o) => o.asset), snapshot.holdings.map((h) => h.asset)],
      [[other().token], [other().token]],
    );
  });
});
