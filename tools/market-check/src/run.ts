import { errorText } from "@vayle/chain-facts/rpc-errors";
import { fetchJson, fetchText, pageStates, SOURCES } from "@vayle/chain-facts/sources";
import { formatUnits, getAddress, isHex, zeroAddress, type Address, type Hex } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { cheapPassed, runCheapChecks, type CheapResult, type InterfaceIds } from "./cheap.ts";
import { notRun } from "./checks.ts";
import { ChainIdMismatch, SourceMismatch } from "./errors.ts";
import { listTokens, type Listed } from "./listing.ts";
import type { Options } from "./options.ts";
import { discoverPools } from "./pools.ts";
import { erc20 } from "./probes.ts";
import { walkRounds, type Walk } from "./rounds.ts";
import type { Rpc } from "./rpc.ts";
import { completedSessions, FEED_MARKET_HOURS, type Session } from "./sessions.ts";
import { judgeStaleness, lastAtOrBefore, stalenessFigures } from "./staleness.ts";
import { strikeStep } from "./strike.ts";
import { checkLiquidity, emptyLiquidity, type Sale } from "./trade.ts";
import type {
  ContractRecord,
  Criteria,
  LiquidityCheck,
  MarketCheck,
  Price,
  RealizedVol,
  StalenessCheck,
  TokenResult,
} from "./types.ts";
import {
  addressListedFor,
  selectUniswapContracts,
  UNISWAP_DEPLOYMENTS,
  type UniswapContracts,
} from "./uniswap.ts";
import { realizedVolBps } from "./vol.ts";

export const CHAIN_ID = facts.chain.chainId;
const USDG = getAddress(facts.usdg.address);
const USDG_DECIMALS = facts.usdg.decimals;
// Robinhood's page on building with Stock Tokens, which names the venues they trade on.
export const TRADING_VENUES = "https://docs.robinhood.com/chain/building-with-stock-tokens";

export const FIXED_CRITERIA = {
  maxGapRule: "heartbeat",
  // The price adapter refuses a round more than a day old at the close.
  maxAgeAtCloseSeconds: 86_400,
  sessions: 5,
  // Session returns, so one more close than sessions.
  realizedVolSessions: 20,
  maxSlippageBps: 100,
  strikeStepPercentOfPrice: 2,
} as const;

export interface Stage {
  readonly name: string;
  readonly calls: number;
}

export interface RunResult {
  readonly check: MarketCheck;
  readonly stages: readonly Stage[];
  readonly calls: number;
  readonly skipped: readonly { readonly symbol: string; readonly reason: string }[];
  readonly notes: readonly string[];
}

function interfaceIds(): InterfaceIds {
  const ids = facts.erc8056.interfaceIds;
  const hex = (value: string): Hex => {
    if (!isHex(value) || value.length !== 10) {
      throw new SourceMismatch(`the recorded ERC-8056 interface id ${value} isn't 4 bytes`);
    }
    return value;
  };
  return {
    core: hex(ids.core),
    balances: hex(ids.balances),
    pending: hex(ids.pending),
    conversion: hex(ids.conversion),
  };
}

function priceOf(cheap: CheapResult): Price | null {
  if (cheap.latestRound === null || cheap.feedDecimals === null) return null;
  return {
    answer: cheap.latestRound.answer.toString(),
    decimals: cheap.feedDecimals,
    updatedAt: cheap.latestRound.updatedAt,
    usd: formatUnits(cheap.latestRound.answer, cheap.feedDecimals),
  };
}

function emptyStaleness(reason: string): StalenessCheck {
  return {
    ...notRun(reason),
    maxRegularHoursGapSeconds: null,
    maxMarketHoursGapSeconds: null,
    maxAgeAtCloseSeconds: null,
    roundsRead: null,
  };
}

function judgeFeedFreshness(
  cheap: CheapResult,
  walk: Walk | undefined,
  lookback: readonly Session[],
  now: number,
): StalenessCheck {
  const listing = cheap.listed.feed;
  if (typeof listing === "string") return emptyStaleness("there's no feed");
  if (walk === undefined) return emptyStaleness("the feed's rounds weren't walked");
  if (!walk.complete) return { ...emptyStaleness(walk.reason), roundsRead: walk.roundsRead };
  if (listing.marketHours !== FEED_MARKET_HOURS) {
    return {
      ...emptyStaleness(`market hours ${listing.marketHours} aren't modeled`),
      roundsRead: walk.roundsRead,
    };
  }
  const updates = walk.rounds.map((r) => r.updatedAt);
  const figures = stalenessFigures(updates, lookback, now);
  const verdict = judgeStaleness(
    figures,
    lookback.map((s) => s.regular.end),
    {
      heartbeatSeconds: listing.heartbeatSeconds,
      maxAgeAtCloseSeconds: FIXED_CRITERIA.maxAgeAtCloseSeconds,
    },
  );
  const ages = figures.agesAtClose.filter((a): a is number => a !== null);
  return {
    status: verdict.pass ? "pass" : "fail",
    reason: verdict.reason,
    maxRegularHoursGapSeconds: figures.maxRegularHoursGapSeconds,
    maxMarketHoursGapSeconds: figures.maxMarketHoursGapSeconds,
    maxAgeAtCloseSeconds: ages.length === 0 ? null : Math.max(...ages),
    roundsRead: walk.roundsRead,
  };
}

// From the feed's last round at or before each of the sessions' closes, out of the walked rounds.
function realizedVol(walk: Walk | undefined, sessions: readonly Session[]): RealizedVol {
  const base = { sessions: FIXED_CRITERIA.realizedVolSessions, closes: null, annualizedBps: null };
  if (walk === undefined) {
    return { status: "not_run", reason: "the feed's rounds weren't walked", ...base };
  }
  if (!walk.complete) return { status: "not_run", reason: walk.reason, ...base };
  const updates = walk.rounds.map((r) => r.updatedAt);
  const prices: bigint[] = [];
  for (const s of sessions) {
    const at = lastAtOrBefore(updates, s.regular.end);
    if (at === null) continue;
    // The last round with that update time, which is the newest one at or before the close.
    const round = walk.rounds.findLast((r) => r.updatedAt === at);
    if (round !== undefined) prices.push(round.answer);
  }
  try {
    return {
      status: "ok",
      reason: "",
      sessions: FIXED_CRITERIA.realizedVolSessions,
      closes: prices.length,
      annualizedBps: realizedVolBps(prices),
    };
  } catch (error) {
    return { status: "not_run", reason: errorText(error), ...base, closes: prices.length };
  }
}

interface Venues {
  readonly contracts: UniswapContracts;
  readonly records: Record<string, ContractRecord>;
  readonly weth: Address | null;
  readonly notes: string[];
}

// Uniswap's contracts from its deployments feed, and WETH and USDG from Robinhood's token contracts
// page, each checked for code at the pinned block.
async function venues(rpc: Rpc): Promise<Venues> {
  const notes: string[] = [];
  const [deployments, tokenPage, venuesPage] = await Promise.all([
    fetchJson(UNISWAP_DEPLOYMENTS),
    fetchText(SOURCES.robinhoodContracts),
    fetchText(TRADING_VENUES),
  ]);
  if (!pageStates(venuesPage, "Uniswap")) {
    notes.push(`${TRADING_VENUES} no longer names Uniswap as a venue for Stock Tokens`);
  }
  const contracts = selectUniswapContracts(deployments, CHAIN_ID);
  const listedUsdg = addressListedFor(tokenPage, "USDG");
  if (listedUsdg !== USDG) {
    throw new SourceMismatch(
      `${SOURCES.robinhoodContracts} lists USDG at ${String(listedUsdg)}, the chain facts at ${USDG}`,
    );
  }
  let weth = addressListedFor(tokenPage, "WETH");
  if (weth !== null) {
    const batch = rpc.batch({ perCall: 4 });
    const symbol = batch.add(erc20.symbol(weth));
    await batch.run();
    const read = symbol.read();
    if (!read.ok || read.value !== "WETH") {
      notes.push(
        `${weth}, listed as WETH, answers symbol() with ${read.ok ? read.value : read.error}`,
      );
      weth = null;
    }
  } else {
    notes.push(`${SOURCES.robinhoodContracts} lists no WETH, so no route goes through it`);
  }
  const entries: [string, Address, string][] = [["usdg", USDG, SOURCES.robinhoodContracts]];
  if (weth !== null) entries.push(["weth", weth, SOURCES.robinhoodContracts]);
  entries.push(
    ["uniswapV2Factory", contracts.v2Factory, UNISWAP_DEPLOYMENTS],
    ["uniswapV2Router02", contracts.v2Router, UNISWAP_DEPLOYMENTS],
    ["uniswapV3Factory", contracts.v3Factory, UNISWAP_DEPLOYMENTS],
    ["uniswapV3QuoterV2", contracts.v3Quoter, UNISWAP_DEPLOYMENTS],
    ["uniswapV4PoolManager", contracts.v4PoolManager, UNISWAP_DEPLOYMENTS],
    ["uniswapV4Quoter", contracts.v4Quoter, UNISWAP_DEPLOYMENTS],
    ["uniswapV4StateView", contracts.v4StateView, UNISWAP_DEPLOYMENTS],
    ["uniswapV4PositionManager", contracts.v4PositionManager, UNISWAP_DEPLOYMENTS],
  );
  const records: Record<string, ContractRecord> = {};
  const codes = await Promise.all(
    entries.map(([, address]) => rpc.client.getCode({ address, blockNumber: rpc.blockNumber })),
  );
  for (const [i, [name, address, source]] of entries.entries()) {
    const code = codes[i] ?? "0x";
    const codeBytes = (code.length - 2) / 2;
    if (codeBytes === 0) throw new SourceMismatch(`${name} at ${address} has no code`);
    records[name] = { address, source, codeBytes };
  }
  return { contracts, records, weth, notes };
}

type StageRunner = <T>(name: string, work: () => Promise<T>) => Promise<T>;

async function liquidityStage(
  rpc: Rpc,
  stage: StageRunner,
  listed: readonly Listed[],
  fresh: readonly CheapResult[],
  options: Options,
): Promise<{
  readonly records: Record<string, ContractRecord>;
  readonly notes: string[];
  readonly checks: Map<Address, LiquidityCheck>;
}> {
  const v = await stage("venues", () => venues(rpc));
  const notes = [...v.notes];
  const names = new Map<Address, string>(listed.map((t) => [t.asset.address, t.asset.symbol]));
  names.set(USDG, "USDG");
  if (v.weth !== null) names.set(v.weth, "WETH");
  const pools = await stage("pool discovery", () =>
    discoverPools(rpc, {
      contracts: v.contracts,
      usdg: USDG,
      weth: v.weth,
      tokens: fresh.map((c) => c.listed.asset.address),
      stockTokens: new Set(listed.map((t) => t.asset.address)),
    }),
  );
  notes.push(
    `pool sample: ${pools.sampled.swaps} swaps in ${pools.sampled.pools} v4 pools, ${pools.sampled.unresolved} without a key in the position manager; ${pools.templates} v4 key shapes tried; v3 fee tiers enabled: ${pools.v3Fees.join(", ")}`,
    ...pools.notes,
  );
  const sales: Sale[] = fresh.flatMap((c) =>
    c.latestRound === null || c.feedDecimals === null
      ? []
      : [
          {
            token: c.listed.asset.address,
            symbol: c.listed.asset.symbol,
            price: {
              answer: c.latestRound.answer,
              feedDecimals: c.feedDecimals,
              tokenDecimals: c.decimals,
              usdgDecimals: USDG_DECIMALS,
            },
          },
        ],
  );
  const checks = await stage("quotes", () =>
    checkLiquidity(
      rpc,
      {
        contracts: v.contracts,
        pools,
        usdg: USDG,
        hubs: v.weth === null ? [zeroAddress] : [zeroAddress, v.weth],
        capUsdBase: options.capUsdBase,
        maxSlippageBps: FIXED_CRITERIA.maxSlippageBps,
        names,
      },
      sales,
    ),
  );
  notes.push(
    `${rpc.retried} quotes reverted without data in a shared call and were sent again alone`,
  );
  return { records: v.records, notes, checks };
}

export async function runMarketCheck(
  rpc: Rpc,
  now: number,
  options: Options,
  generatedAt: Date,
): Promise<RunResult> {
  const stages: Stage[] = [];
  const notes: string[] = [];
  const stage: StageRunner = async (name, work) => {
    const before = rpc.calls;
    try {
      return await work();
    } finally {
      stages.push({ name, calls: rpc.calls - before });
    }
  };

  const chainId = await stage("chain id", () => rpc.client.getChainId());
  if (chainId !== CHAIN_ID)
    throw new ChainIdMismatch(`the RPC is chain ${chainId}, not ${CHAIN_ID}`);

  const [registry, directory] = await Promise.all([
    fetchJson(SOURCES.stockTokenRegistry),
    fetchJson(SOURCES.feedDirectory),
  ]);
  const listing = listTokens(registry, directory, CHAIN_ID);
  const cheap = await stage("cheap checks", () =>
    runCheapChecks(rpc, listing.tokens, interfaceIds(), now),
  );

  // Rounds back past the oldest close realized volatility uses, which covers the staleness lookback.
  // Twenty session returns take the last 21 closes.
  const sessions = completedSessions(now, FIXED_CRITERIA.realizedVolSessions + 1);
  const lookback = sessions.slice(-FIXED_CRITERIA.sessions);
  const oldest = sessions[0];
  if (oldest === undefined) throw new RangeError("no sessions");
  const walked = cheap.filter((c) => cheapPassed(c) && c.latestRound !== null);
  const walks = await stage("round walk", () =>
    walkRounds(
      rpc,
      walked.flatMap((c) =>
        typeof c.listed.feed === "string" || c.latestRound === null
          ? []
          : [{ proxy: c.listed.feed.proxy, latest: c.latestRound, until: oldest.regular.end }],
      ),
    ),
  );
  const proxyOf = (c: CheapResult): Address | null =>
    typeof c.listed.feed === "string" ? null : c.listed.feed.proxy;

  const staleness = new Map<Address, StalenessCheck>();
  const vols = new Map<Address, RealizedVol>();
  for (const c of cheap) {
    const proxy = proxyOf(c);
    const walk = proxy === null ? undefined : walks.get(proxy);
    if (!cheapPassed(c)) {
      staleness.set(c.listed.asset.address, emptyStaleness("the cheap checks didn't pass"));
      continue;
    }
    staleness.set(c.listed.asset.address, judgeFeedFreshness(c, walk, lookback, now));
    vols.set(c.listed.asset.address, realizedVol(walk, sessions));
  }

  // Liquidity on the tokens whose feed kept fresh. If it stops, the cheap checks and staleness
  // are still written, and each of those tokens records why liquidity wasn't checked.
  const liquidity = new Map<Address, LiquidityCheck>();
  const fresh = cheap.filter((c) => staleness.get(c.listed.asset.address)?.status === "pass");
  let records: Record<string, ContractRecord> = {};
  if (fresh.length > 0) {
    try {
      const result = await liquidityStage(rpc, stage, listing.tokens, fresh, options);
      records = result.records;
      notes.push(...result.notes);
      for (const [token, check] of result.checks) liquidity.set(token, check);
    } catch (error) {
      const reason = `the liquidity check stopped: ${errorText(error)}`;
      notes.push(reason);
      for (const c of fresh) {
        liquidity.set(c.listed.asset.address, emptyLiquidity("not_run", reason));
      }
    }
  }

  const tokens: TokenResult[] = cheap.map((c) => {
    const address = c.listed.asset.address;
    const price = priceOf(c);
    const stale = staleness.get(address) ?? emptyStaleness("not checked");
    const liquid =
      liquidity.get(address) ??
      emptyLiquidity(
        "not_run",
        cheapPassed(c) ? "the feed's staleness check didn't pass" : "the cheap checks didn't pass",
      );
    const checks = {
      feed: c.feed,
      erc8056: c.erc8056,
      multiplier: c.multiplier,
      pauses: c.pauses,
      uid: c.uidCheck,
      staleness: stale,
      liquidity: liquid,
    };
    const step =
      c.latestRound === null || c.feedDecimals === null
        ? null
        : strikeStep(
            c.latestRound.answer,
            c.feedDecimals,
            USDG_DECIMALS,
            FIXED_CRITERIA.strikeStepPercentOfPrice,
          );
    return {
      symbol: c.listed.asset.symbol,
      name: c.name,
      address,
      uid: c.uid,
      decimals: c.decimals,
      registryStatus: c.listed.asset.status,
      price,
      realizedVol: vols.get(address) ?? {
        status: "not_run",
        reason: "the cheap checks didn't pass",
        sessions: FIXED_CRITERIA.realizedVolSessions,
        closes: null,
        annualizedBps: null,
      },
      proposedStrikeStep: step === null ? null : step.toString(),
      checks,
      passed: Object.values(checks).every((check) => check.status === "pass"),
    };
  });

  const { count: unavailable, first } = rpc.unavailable;
  if (unavailable > 0) {
    notes.push(`${unavailable} reads couldn't be made, the first because ${String(first)}`);
  }
  const criteria: Criteria = { ...FIXED_CRITERIA, capUsd: options.capUsd };
  return {
    check: {
      schemaVersion: 1,
      generatedAt: generatedAt.toISOString(),
      chainId,
      block: { number: rpc.blockNumber.toString(), timestamp: now },
      sources: {
        stockTokens: SOURCES.stockTokenRegistry,
        feeds: SOURCES.feedDirectory,
        dexes: [TRADING_VENUES, UNISWAP_DEPLOYMENTS],
      },
      criteria,
      contracts: records,
      tokens,
    },
    stages,
    calls: rpc.calls,
    skipped: listing.skipped,
    notes,
  };
}
