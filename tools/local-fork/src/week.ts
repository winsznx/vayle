import { appendFileSync } from "node:fs";
import { vayleMarketAbi } from "@vayle/abi";
import {
  keeperClients,
  loadConfig as keeperConfig,
  runOnce as runKeeper,
  type Clients as KeeperClients,
  type KeeperConfig,
} from "@vayle/keeper";
import {
  loadConfig as loadMakerConfig,
  makerClients,
  runOnce as runMaker,
  type Clients as MakerClients,
  type MakerConfig,
} from "@vayle/maker";
import { markets } from "@vayle/markets";
import { formatUnits, getAddress, parseAbi, type Address } from "viem";
import type { Accounts } from "./accounts.ts";
import { FORK_RPC, type ForkClient } from "./anvil.ts";
import {
  advanceTarget,
  AFTER_FIRST_WEEK,
  FEED_LEAD,
  minutesTarget,
  nextTick,
  type Week,
} from "./clock.ts";
import type { Deployment } from "./deploy.ts";
import { writeRound } from "./feed.ts";
import { FEED_WRITES_FILE } from "./paths.ts";

// The maker's pricing inputs on the fork. Illustrative only: the owner sets the real ones. Each
// market's volatility comes from deployments/markets.json, as in production.
const FORK_MAKER_PRICING = {
  MAKER_EDGE_BPS: "1000",
  MAKER_DIVIDEND_YIELD_BPS: "2",
  MAKER_RATE_BPS: "400",
  MAKER_RFQ: "on",
};
// The week's clock follows the first market. Every market shares the calendar.
const LEAD_MARKET = markets[0];
const proxyAbi = parseAbi(["function aggregator() view returns (address)"]);
// Each tick's routine pings, left out of the log.
const PINGS = new Set(["checkpoint", "observeClose", "observePauses"]);

const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

export function easternTime(seconds: number): string {
  return eastern.format(new Date(seconds * 1000));
}

interface Services {
  readonly keeper: { readonly config: KeeperConfig; readonly clients: KeeperClients };
  readonly maker: { readonly config: MakerConfig; readonly clients: MakerClients };
}

// The maker's config as its Worker would load it, pointed at the fork.
export function makerConfig(deployment: Deployment, accounts: Accounts): MakerConfig {
  return loadMakerConfig({
    MAKER_KEY: accounts.keys.maker,
    ROBINHOOD_RPC_URL: FORK_RPC,
    VAYLE_MARKET: deployment.market,
    VAYLE_REGISTRY: deployment.registry,
    ...FORK_MAKER_PRICING,
  });
}

// The production keeper and maker, configured the way their Workers are and with their Workers'
// own clients, pointed at the fork.
function services(deployment: Deployment, accounts: Accounts): Services {
  return {
    keeper: {
      config: keeperConfig({
        KEEPER_KEY: accounts.keys.keeper,
        ROBINHOOD_RPC_URL: FORK_RPC,
        VAYLE_MARKET: deployment.market,
        VAYLE_LIVENESS: deployment.liveness,
        VAYLE_CALENDAR: deployment.calendar,
        VAYLE_REGISTRY: deployment.registry,
      }),
      clients: keeperClients({ rpcUrl: FORK_RPC, key: accounts.keys.keeper }),
    },
    maker: {
      config: makerConfig(deployment, accounts),
      clients: makerClients({ rpcUrl: FORK_RPC, key: accounts.keys.maker }),
    },
  };
}

export async function latestWeek(
  client: ForkClient,
  market: Deployment["market"],
): Promise<Week | null> {
  const asset = LEAD_MARKET.token;
  const expiry = await client.readContract({
    address: market,
    abi: vayleMarketAbi,
    functionName: "latestExpiry",
    args: [asset],
  });
  if (expiry === 0n) return null;
  const e = await client.readContract({
    address: market,
    abi: vayleMarketAbi,
    functionName: "epoch",
    args: [asset, expiry],
  });
  return {
    opening: Number(e.opening),
    expiry: Number(e.expiry),
    windowLength: e.windowLength,
    batchDeadline: Number(e.batchDeadline),
  };
}

// When a market with no week yet can open its first one: once its liveness record covers the
// lookback after the deploy. Null once the schedule's first close has passed, when weeks open at
// closes instead.
async function firstWeekAt(
  client: ForkClient,
  market: Deployment["market"],
  firstClose: number | null,
  now: number,
): Promise<number | null> {
  if (firstClose === null || now >= firstClose) return null;
  const [deployedAt, lookback] = await Promise.all([
    client.readContract({ address: market, abi: vayleMarketAbi, functionName: "deployedAt" }),
    client.readContract({
      address: market,
      abi: vayleMarketAbi,
      functionName: "LIVENESS_LOOKBACK",
    }),
  ]);
  return Number(deployedAt) + Number(lookback);
}

async function aggregatorOf(client: ForkClient, feed: Address): Promise<Address> {
  return getAddress(
    await client.readContract({ address: feed, abi: proxyAbi, functionName: "aggregator" }),
  );
}

async function chainTime(client: ForkClient): Promise<number> {
  return Number((await client.getBlock({ blockTag: "latest" })).timestamp);
}

async function mineAt(client: ForkClient, t: number): Promise<void> {
  await client.setNextBlockTimestamp({ timestamp: BigInt(t) });
  await client.mine({ blocks: 1 });
}

export interface AdvanceOptions {
  // Minutes ahead, instead of the next moment of the week.
  readonly minutes: number | null;
  // False plays a keeper that has died: no pings, no epochs, nothing settled for anyone.
  readonly keeper: boolean;
  // The answer the next close crossed gets, in the feed's decimals, or null to repeat the latest.
  readonly closeAt: bigint | null;
}

// Moves the fork to the next moment of the week, or some minutes ahead, running the keeper and the
// maker once a tick the way their crons would. Crossing a close's feed time, it first writes that
// close's feed round.
export async function advance(
  client: ForkClient,
  deployment: Deployment,
  accounts: Accounts,
  closes: readonly number[],
  { minutes, keeper: keeperRuns, closeAt }: AdvanceOptions = {
    minutes: null,
    keeper: true,
    closeAt: null,
  },
): Promise<void> {
  const { keeper, maker } = services(deployment, accounts);
  const now = await chainTime(client);
  const bidWindow = await client.readContract({
    address: deployment.market,
    abi: vayleMarketAbi,
    functionName: "BID_WINDOW",
  });
  const week = await latestWeek(client, deployment.market);
  const firstAt = await firstWeekAt(client, deployment.market, closes[0] ?? null, now);
  const target =
    minutes === null
      ? advanceTarget(
          now,
          week,
          closes.find((c) => c > now) ?? null,
          Number(bidWindow),
          week === null ? firstAt : null,
        )
      : minutesTarget(now, minutes);
  // Dense ticks while a first week waits, so the keeper's checkpoints leave no gap.
  const denseUntil = week === null && firstAt !== null ? firstAt + AFTER_FIRST_WEEK : 0;
  const feeds = await Promise.all(
    markets.map(async (m) => ({ market: m, aggregator: await aggregatorOf(client, m.feed) })),
  );
  console.log(
    `Advancing to ${easternTime(target.at)}: ${target.what}${keeperRuns ? "" : ", with no keeper"}.`,
  );
  // A chosen price goes to the first close crossed. Later closes repeat the latest answer again.
  let chosen = closeAt;
  let t = now;
  for (;;) {
    const previous = t;
    t = Math.max(nextTick(t, closes, denseUntil), (await chainTime(client)) + 1);
    if (t > target.at) break;
    await mineAt(client, t);
    for (const close of closes) {
      const at = close - FEED_LEAD;
      if (previous < at && at <= t) {
        // A chosen price goes to the first market's first close crossed. Every other feed repeats
        // its latest answer.
        for (const { market: m, aggregator } of feeds) {
          const write = await writeRound(
            client,
            m.feed,
            aggregator,
            at,
            m === LEAD_MARKET ? chosen : null,
          );
          appendFileSync(FEED_WRITES_FILE, `${JSON.stringify({ symbol: m.symbol, ...write })}\n`);
          console.log(
            write.chosen
              ? `${easternTime(t)}  ${m.symbol} feed round ${write.round} written: ${formatUnits(BigInt(write.answer), m.feedDecimals)}, the price chosen with --close-at, at ${easternTime(at)}`
              : `${easternTime(t)}  ${m.symbol} feed round ${write.round} written: round ${write.copiedFrom}'s answer at ${easternTime(at)}`,
          );
        }
        chosen = null;
      }
    }
    const kept = keeperRuns
      ? await runKeeper(keeper.config, keeper.clients)
      : { sent: [], failed: [] };
    const made = await runMaker(maker.config, maker.clients);
    const done = [
      ...kept.sent.map((a) => a.kind).filter((kind) => !PINGS.has(kind)),
      ...made.sent.map((a) => `maker ${a.kind}`),
    ];
    if (done.length > 0) console.log(`${easternTime(t)}  ${done.join(", ")}`);
  }
  if ((await chainTime(client)) < target.at) await mineAt(client, target.at);
}
