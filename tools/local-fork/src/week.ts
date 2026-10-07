import { appendFileSync } from "node:fs";
import { vayleMarketAbi } from "@vayle/abi";
import {
  loadConfig as keeperConfig,
  runOnce as runKeeper,
  type Clients as KeeperClients,
  type KeeperConfig,
} from "@vayle/keeper";
import {
  loadConfig as makerConfig,
  runOnce as runMaker,
  type Clients as MakerClients,
  type MakerConfig,
} from "@vayle/maker";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import type { Accounts } from "./accounts.ts";
import { FORK_RPC, forkChain, type ForkClient } from "./anvil.ts";
import { advanceTarget, FEED_LEAD, minutesTarget, nextTick, type Week } from "./clock.ts";
import type { Deployment } from "./deploy.ts";
import { writeCarriedForwardRound } from "./feed.ts";
import { FEED_WRITES_FILE } from "./paths.ts";

// The maker's pricing inputs on the fork. Illustrative only: the owner sets the real ones.
const FORK_MAKER_PRICING = {
  MAKER_VOL_BPS: "5000",
  MAKER_EDGE_BPS: "1000",
  MAKER_DIVIDEND_YIELD_BPS: "2",
  MAKER_RATE_BPS: "400",
  MAKER_MAX_PER_SERIES: (10n * 10n ** BigInt(facts.nvda.decimals)).toString(),
  MAKER_RFQ: "on",
};
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

// The production keeper and maker, configured the way their Workers are, pointed at the fork.
function services(deployment: Deployment, accounts: Accounts): Services {
  const transport = http(FORK_RPC);
  const publicClient = createPublicClient({ chain: forkChain, transport });
  const keeperAccount = privateKeyToAccount(accounts.keys.keeper);
  const makerSigner = privateKeyToAccount(accounts.keys.maker);
  return {
    keeper: {
      config: keeperConfig({
        KEEPER_KEY: accounts.keys.keeper,
        ROBINHOOD_RPC_URL: FORK_RPC,
        VAYLE_MARKET: deployment.market,
        VAYLE_LIVENESS: deployment.liveness,
        VAYLE_CALENDAR: deployment.calendar,
      }),
      clients: {
        public: publicClient,
        wallet: createWalletClient({ account: keeperAccount, chain: forkChain, transport }),
      },
    },
    maker: {
      config: makerConfig({
        MAKER_KEY: accounts.keys.maker,
        ROBINHOOD_RPC_URL: FORK_RPC,
        VAYLE_MARKET: deployment.market,
        ...FORK_MAKER_PRICING,
      }),
      clients: {
        public: publicClient,
        wallet: createWalletClient({ account: makerSigner, chain: forkChain, transport }),
        signer: makerSigner,
      },
    },
  };
}

export async function latestWeek(
  client: ForkClient,
  market: Deployment["market"],
): Promise<Week | null> {
  const asset = getAddress(facts.nvda.address);
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
  return { opening: Number(e.opening), expiry: Number(e.expiry), windowLength: e.windowLength };
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
}

// Moves the fork to the next moment of the week, or some minutes ahead, running the keeper and the
// maker once a tick the way their crons would. Crossing a close's feed time, it first writes that
// close's feed round.
export async function advance(
  client: ForkClient,
  deployment: Deployment,
  accounts: Accounts,
  closes: readonly number[],
  { minutes, keeper: keeperRuns }: AdvanceOptions = { minutes: null, keeper: true },
): Promise<void> {
  const { keeper, maker } = services(deployment, accounts);
  const now = await chainTime(client);
  const bidWindow = await client.readContract({
    address: deployment.market,
    abi: vayleMarketAbi,
    functionName: "BID_WINDOW",
  });
  const target =
    minutes === null
      ? advanceTarget(
          now,
          await latestWeek(client, deployment.market),
          closes.find((c) => c > now) ?? null,
          Number(bidWindow),
        )
      : minutesTarget(now, minutes);
  console.log(
    `Advancing to ${easternTime(target.at)}: ${target.what}${keeperRuns ? "" : ", with no keeper"}.`,
  );
  let t = now;
  for (;;) {
    const previous = t;
    t = Math.max(nextTick(t, closes), (await chainTime(client)) + 1);
    if (t > target.at) break;
    await mineAt(client, t);
    for (const close of closes) {
      const at = close - FEED_LEAD;
      if (previous < at && at <= t) {
        const write = await writeCarriedForwardRound(
          client,
          getAddress(facts.nvdaUsdFeed.proxy),
          getAddress(facts.nvdaUsdFeed.aggregator),
          at,
        );
        appendFileSync(FEED_WRITES_FILE, `${JSON.stringify(write)}\n`);
        console.log(
          `${easternTime(t)}  feed round ${write.round} written: round ${write.copiedFrom}'s answer at ${easternTime(at)}`,
        );
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
