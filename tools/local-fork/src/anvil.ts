import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { robinhoodChain } from "@vayle/chain-facts/chain";
import {
  createTestClient,
  defineChain,
  getAddress,
  http,
  publicActions,
  walletActions,
  type Chain,
} from "viem";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { AnvilDidNotStart, ForkNotRunning } from "./errors.ts";

const PORT = 8545;
export const FORK_RPC = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 30_000;
// Fee estimates read the last ten blocks' fee history. The fork asks the forked RPC about blocks
// from before the fork, and an RPC that keeps little old state refuses once the fork block is a few
// minutes old. Blocks of the fork's own answer those questions locally.
const OWN_BLOCKS = 16;
const POLL_MS = 250;

export const forkChain: Chain = defineChain({
  ...robinhoodChain,
  name: "Robinhood Chain (local fork)",
  rpcUrls: { default: { http: [FORK_RPC] } },
});

export function forkClient() {
  return createTestClient({ chain: forkChain, mode: "anvil", transport: http(FORK_RPC) })
    .extend(publicActions)
    .extend(walletActions);
}

export type ForkClient = ReturnType<typeof forkClient>;

// The fork answers and is the chain the facts describe.
export async function requireFork(client: ForkClient): Promise<void> {
  let chainId: number;
  try {
    chainId = await client.getChainId();
  } catch (error) {
    throw new ForkNotRunning(`nothing answers at ${FORK_RPC}; start it with pnpm fork up`, {
      cause: error,
    });
  }
  if (chainId !== facts.chain.chainId) {
    throw new ForkNotRunning(`${FORK_RPC} is chain ${chainId}, not ${facts.chain.chainId}`);
  }
}

// Starts anvil on a fork of `forkUrl` with the chain's own code size limit, and resolves once it
// answers. Its output goes to `logPath`.
export async function startAnvil(forkUrl: string, logPath: string): Promise<ChildProcess> {
  const log = createWriteStream(logPath);
  const anvil = spawn(
    "anvil",
    [
      "--fork-url",
      forkUrl,
      "--port",
      String(PORT),
      "--code-size-limit",
      String(facts.chain.maxCodeSize),
      "--no-rate-limit",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  anvil.stdout.pipe(log);
  anvil.stderr.pipe(log);
  const client = forkClient();
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) {
      throw new AnvilDidNotStart(`anvil exited with code ${anvil.exitCode}; see ${logPath}`);
    }
    try {
      await requireFork(client);
    } catch (error) {
      lastError = error;
      await sleep(POLL_MS);
      continue;
    }
    await loadMulticall3(client, anvil);
    await client.mine({ blocks: OWN_BLOCKS });
    return anvil;
  }
  anvil.kill();
  throw new AnvilDidNotStart(`anvil didn't answer within 30 s; see ${logPath}`, {
    cause: lastError,
  });
}

// The fork loads an account from the forked RPC the first time something touches it, and an RPC
// that prunes old state can't serve it once the fork block ages. The app batches its reads through
// Multicall3, so it's loaded while the fork block is still fresh.
async function loadMulticall3(client: ForkClient, anvil: ChildProcess): Promise<void> {
  const code = await client.getCode({ address: getAddress(facts.multicall3.address) });
  if (code === undefined || code === "0x") {
    anvil.kill();
    throw new AnvilDidNotStart(`the fork has no Multicall3 at ${facts.multicall3.address}`);
  }
}
