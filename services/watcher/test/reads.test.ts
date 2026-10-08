import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  livenessCheckpointAbi,
  sessionCalendarAbi,
  stockTokenRegistryAbi,
  vayleMarketAbi,
} from "@vayle/abi";
import type { Market } from "@vayle/markets";
import { parseAbi, type Address } from "viem";
import { watcherClient } from "../src/clients.ts";
import { loadConfig } from "../src/config.ts";
import { readSnapshot } from "../src/snapshot.ts";
import { ACCESS_REGISTRY, NOW, nvda, OCT_02, OCT_09, other } from "./fixtures.ts";
import { byAddress, fakeChain, Revert, type FakeContract } from "./rpc.ts";

const MARKET: Address = "0x00000000000000000000000000000000000000aa";
const LIVENESS: Address = "0x00000000000000000000000000000000000000bb";
const CALENDAR: Address = "0x00000000000000000000000000000000000000cc";
const REGISTRY: Address = "0x00000000000000000000000000000000000000dd";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const tokenAbi = parseAbi([
  "function paused() view returns (bool)",
  "function oraclePaused() view returns (bool)",
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
]);
const pausableAbi = parseAbi(["function paused() view returns (bool)"]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);
const revertAbi = parseAbi(["error Error(string)"]);

interface World {
  // Whether the market's addresses are set, as they are once it's deployed.
  readonly deployed: boolean;
  // A token whose every read reverts, and a token the registry lists with another feed.
  readonly brokenToken?: Address;
  readonly relisted?: Address;
}

function contracts(listed: readonly Market[], world: World): Map<string, FakeContract> {
  const token = (address: Address): FakeContract => ({
    abi: tokenAbi,
    read: (name) => {
      if (address === world.brokenToken) return new Revert(revertAbi, "Error", ["broken"]);
      if (name === "uiMultiplier" || name === "newUIMultiplier") return 10n ** 18n;
      if (name === "effectiveAt") return BigInt(OCT_02);
      if (name === "ACCESS_CONTROLLED_REGISTRY") return ACCESS_REGISTRY;
      return false;
    },
  });
  const feed: FakeContract = {
    abi: feedAbi,
    read: () => [1n, 23_700_000_000n, BigInt(NOW - 600), BigInt(NOW - 600), 1n],
  };
  const pausable: FakeContract = { abi: pausableAbi, read: () => false };
  // Ten weekly boundaries from the Oct 2 close.
  const boundaries = Array.from({ length: 10 }, (_, i) => ({
    close: BigInt(OCT_02 + i * 7 * 86_400),
    creationDeadline: BigInt(OCT_02 + i * 7 * 86_400 + 2 * 86_400 + 17 * 3600 + 1800),
  }));
  const market: FakeContract = {
    abi: vayleMarketAbi,
    read: (name, args) => {
      switch (name) {
        case "paused":
        case "assetPaused":
          return false;
        case "haltedUntil":
          return 0n;
        case "deployedAt":
          return BigInt(OCT_02 - 7 * 86_400);
        case "LIVENESS_LOOKBACK":
          return 1800n;
        case "latestExpiry":
          return BigInt(OCT_09);
        case "capsOf": {
          const m = listed.find((l) => l.token.toLowerCase() === String(args[0]).toLowerCase());
          if (m === undefined) throw new Error("unexpected token");
          return args[1] === 0 ? m.sell.caps : m.buy.caps;
        }
        default:
          throw new Error(`unexpected market read ${name}`);
      }
    },
  };
  const calendar: FakeContract = {
    abi: sessionCalendarAbi,
    read: (name, args) =>
      name === "boundaryCount" ? BigInt(boundaries.length) : boundaries[Number(args[0])],
  };
  const liveness: FakeContract = { abi: livenessCheckpointAbi, read: () => BigInt(NOW - 60) };
  const registry: FakeContract = {
    abi: stockTokenRegistryAbi,
    read: (_name, args) => {
      const m = listed.find((l) => l.token.toLowerCase() === String(args[0]).toLowerCase());
      if (m === undefined) throw new Error("unexpected token");
      return {
        uid: m.uid,
        feed: m.token === world.relisted ? USDG : m.feed,
        decimals: m.decimals,
        feedDecimals: m.feedDecimals,
        rawUnit: m.rawUnit,
        lot: m.lot,
        priceTick: m.priceTick,
        strikeTick: m.strikeTick,
        strikeRangeBps: m.strikeRangeBps,
        listed: true,
      };
    },
  };
  return byAddress([
    [USDG, pausable],
    [ACCESS_REGISTRY, pausable],
    [MARKET, market],
    [CALENDAR, calendar],
    [LIVENESS, liveness],
    [REGISTRY, registry],
    ...listed.flatMap((m) => [[m.token, token(m.token)] as const, [m.feed, feed] as const]),
  ]);
}

async function read(listed: readonly Market[], world: World) {
  const chain = fakeChain({ number: 82_900_000n, timestamp: NOW }, contracts(listed, world));
  const env = {
    ROBINHOOD_RPC_URL: "https://rpc.invalid",
    WATCHER_WEBHOOK_URL: "https://hooks.example/alerts",
    SUPABASE_URL: "https://project.supabase.example",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
  };
  const market = {
    VAYLE_MARKET: MARKET,
    VAYLE_LIVENESS: LIVENESS,
    VAYLE_CALENDAR: CALENDAR,
    VAYLE_REGISTRY: REGISTRY,
    VAYLE_START_BLOCK: "82000000",
  };
  const config = loadConfig(world.deployed ? { ...env, ...market } : env, listed);
  const snapshot = await readSnapshot(watcherClient(config.rpcUrl, chain.fetchFn), config);
  return { snapshot, requests: chain.requests.length };
}

async function oneAndTwo(world: World): Promise<[number, number]> {
  return [(await read([nvda()], world)).requests, (await read([nvda(), other()], world)).requests];
}

describe("requests per snapshot", () => {
  it("are three before the market is deployed, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ deployed: false });
    // #then: the block, every token and feed, then the access registry they name
    assert.deepEqual(counts, [3, 3]);
  });

  it("are three once it's deployed, for one market or two", async () => {
    // #when
    const counts = await oneAndTwo({ deployed: true });
    // #then: the block, every token, feed and market read, then the access registry and calendar
    assert.deepEqual(counts, [3, 3]);
  });
});

describe("readSnapshot with one bad market", () => {
  it("marks a market whose token refuses its reads, and reads the other", async () => {
    // #when
    const { snapshot } = await read([nvda(), other()], {
      deployed: true,
      brokenToken: other().token,
    });
    // #then
    assert.deepEqual(
      snapshot.markets.map((w) => [w.market.symbol, w.unreadable === null, w.token === null]),
      [
        ["NVDA", true, false],
        ["TWO", false, true],
      ],
    );
  });

  it("names how a market's listing differs from the markets file", async () => {
    // #when
    const { snapshot } = await read([nvda(), other()], { deployed: true, relisted: nvda().token });
    // #then
    assert.deepEqual(
      snapshot.markets.map((w) => w.listing),
      [`feed is ${USDG} in the registry and ${nvda().feed} in the markets file`, null],
    );
  });
});
