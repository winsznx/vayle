// A local anvil fork of Robinhood Chain with Vayle deployed by the production deploy script, and
// the week driven by the production keeper and maker:
//   pnpm fork up        start the fork, deploy, fund a holder, open the first week (stays running)
//   pnpm fork advance   move the running fork to the next moment of the week
//   pnpm fork advance <minutes>   or that many minutes ahead
//   pnpm fork advance [minutes] --without-keeper   as if the keeper had died
//   pnpm fork advance --close-at 250.00   the next close at that price, to rehearse a fill
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { boundariesAfter, type Boundary } from "@vayle/calendar";
import { markets } from "@vayle/markets";
import { formatUnits, getAddress, parseEther, parseUnits } from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { addressOf, newAccounts, readAccounts, ROLES, saveAccounts } from "./accounts.ts";
import { FORK_RPC, forkClient, requireFork, startAnvil } from "./anvil.ts";
import { deployToFork, readDeployment, type Deployment } from "./deploy.ts";
import { DeployFailed, ForkNotRunning, MissingSetting } from "./errors.ts";
import { fund } from "./fund.ts";
import {
  ACCOUNTS_FILE,
  ANVIL_LOG,
  BOUNDARIES_FILE,
  FORK_DIR,
  RECORD_FILE,
  WEB_ENV_FILE,
} from "./paths.ts";
import { advanceOptions, USAGE, UsageError } from "./options.ts";
import { advance, easternTime, latestWeek, type AdvanceOptions } from "./week.ts";

const WEEKS = 26;
const GAS = parseEther("100");
const usdg = getAddress(facts.usdg.address);

function readBoundaries(): Boundary[] {
  return JSON.parse(readFileSync(BOUNDARIES_FILE, "utf8")) as Boundary[];
}

async function up(): Promise<void> {
  const forkUrl = process.env["ROBINHOOD_RPC_URL"];
  if (forkUrl === undefined || forkUrl === "") {
    throw new MissingSetting("set ROBINHOOD_RPC_URL to the Robinhood Chain RPC to fork");
  }
  rmSync(FORK_DIR, { recursive: true, force: true });
  mkdirSync(FORK_DIR, { recursive: true });
  const anvil = await startAnvil(forkUrl, ANVIL_LOG);
  try {
    const client = forkClient();
    const forkedAt = await client.getBlock({ blockTag: "latest" });
    const accounts = newAccounts();
    saveAccounts(accounts);
    for (const role of ROLES) {
      await client.setBalance({ address: addressOf(accounts, role), value: GAS });
    }
    // The deploy requires the multisig to be a contract. Any code stands in for it on the fork.
    await client.setCode({ address: accounts.multisig, bytecode: "0x00" });
    const boundaries = boundariesAfter(Number(forkedAt.timestamp), WEEKS);
    writeFileSync(BOUNDARIES_FILE, `${JSON.stringify(boundaries, null, 2)}\n`);

    console.log(`Forked block ${forkedAt.number}. Deploying with the production deploy script.`);
    const deployment = deployToFork({
      DEPLOYER_KEY: accounts.keys.deployer,
      MULTISIG: accounts.multisig,
      GUARDIAN: addressOf(accounts, "guardian"),
      TEAM_MAKER: addressOf(accounts, "maker"),
    });
    // forge can report success for a broadcast whose last transactions never mined.
    const code = await client.getCode({ address: deployment.market });
    if (code === undefined || code === "0x") {
      throw new DeployFailed(`forge reported a deploy, but ${deployment.market} has no code`);
    }
    const holder = addressOf(accounts, "holder");
    const maker = addressOf(accounts, "maker");
    // The holder can fill each market's whole sell cap, and the maker holds enough of each token
    // to cover every buy target the caps allow.
    await fund(client, [
      ...markets.flatMap((m) => [
        { to: holder, token: m.token, amount: m.sell.caps.openSize },
        { to: maker, token: m.token, amount: m.buy.caps.openSize },
      ]),
      { to: holder, token: usdg, amount: parseUnits("10000", facts.usdg.decimals) },
      { to: maker, token: usdg, amount: parseUnits("100000", facts.usdg.decimals) },
    ]);
    const holdings = markets
      .map((m) => `${formatUnits(m.sell.caps.openSize, m.decimals)} ${m.symbol}`)
      .join(", ");
    await advance(
      client,
      deployment,
      accounts,
      boundaries.map((b) => b.close),
    );
    writeFileSync(
      WEB_ENV_FILE,
      `VITE_RPC_URL=${FORK_RPC}\nVITE_MARKET=${deployment.market}\nVITE_MARKET_DEPLOY_BLOCK=${deployment.block.toString()}\nVITE_PLACEMENT=open\n`,
    );

    const week = await latestWeek(client, deployment.market);
    console.log(
      [
        "",
        `The fork is up at ${FORK_RPC}, chain ${facts.chain.chainId}, from block ${forkedAt.number}.`,
        `Market ${deployment.market}. Every address is in ${RECORD_FILE}.`,
        `Holder ${holder} has ${holdings} and 10,000 USDG. Its key is in ${ACCOUNTS_FILE}.`,
        week === null
          ? "No week opened. Check the keeper output above."
          : week.batchDeadline <= week.opening
            ? `The first week opened at ${easternTime(week.opening)} and runs to the ${easternTime(week.expiry)} close, filled by the maker's quotes.`
            : `This week opened at the ${easternTime(week.opening)} close.`,
        "",
        "App:            pnpm --filter @vayle/web dev:fork",
        "Next moment:    pnpm fork advance",
        "Ctrl-C stops the fork.",
      ].join("\n"),
    );
  } catch (error) {
    anvil.kill();
    throw error;
  }
  await new Promise<void>((resolve) => {
    anvil.once("exit", () => {
      resolve();
    });
  });
}

async function advanceRunning(options: AdvanceOptions): Promise<void> {
  const client = forkClient();
  await requireFork(client);
  let deployment: Deployment;
  try {
    deployment = readDeployment();
  } catch (error) {
    throw new ForkNotRunning(`can't read ${RECORD_FILE}; run pnpm fork up`, { cause: error });
  }
  const code = await client.getCode({ address: deployment.market });
  if (code === undefined || code === "0x") {
    throw new ForkNotRunning(
      `the running fork has no market at ${deployment.market}; run pnpm fork up again`,
    );
  }
  await advance(
    client,
    deployment,
    readAccounts(),
    readBoundaries().map((b) => b.close),
    options,
  );
}

async function main(command: string | undefined, args: readonly string[]): Promise<void> {
  if (command === "up") return up();
  if (command === "advance") {
    return advanceRunning(advanceOptions(args, markets[0].feedDecimals));
  }
  throw new UsageError(USAGE);
}

try {
  await main(process.argv[2], process.argv.slice(3));
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
}
