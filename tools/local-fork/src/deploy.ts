import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { FORK_RPC } from "./anvil.ts";
import { DeployFailed } from "./errors.ts";
import { CONTRACTS_DIR, RECORD_FILE } from "./paths.ts";

export interface Deployment {
  readonly block: number;
  readonly timelock: Address;
  readonly liveness: Address;
  readonly calendar: Address;
  readonly registry: Address;
  readonly priceAdapter: Address;
  readonly market: Address;
}

const TAIL_LINES = 30;

// Only what forge needs, so no key or setting from the developer's own environment reaches it.
function forgeEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "ROBINHOOD_RPC_URL"]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  return { ...inherited, ...env };
}

// Broadcasts the production deploy script to the fork. DeployFork only moves its input and output
// files to deployments/fork/. forge script checks sizes against Ethereum's 24,576-byte limit
// whatever code_size_limit says, and asks before going on, so --non-interactive answers it. Anvil
// still enforces the chain's own limit on every deploy.
export function deployToFork(env: Readonly<Record<string, string>>): Deployment {
  const result = spawnSync(
    "forge",
    [
      "script",
      "script/DeployFork.s.sol:DeployFork",
      "--rpc-url",
      FORK_RPC,
      "--broadcast",
      "--non-interactive",
    ],
    { cwd: CONTRACTS_DIR, env: forgeEnv(env), encoding: "utf8" },
  );
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n");
    throw new DeployFailed(
      `forge script exited with ${result.status}:\n${output.slice(-TAIL_LINES).join("\n")}`,
    );
  }
  return readDeployment();
}

export function readDeployment(): Deployment {
  const raw = JSON.parse(readFileSync(RECORD_FILE, "utf8")) as Record<string, unknown>;
  const address = (name: string): Address => getAddress(String(raw[name]));
  return {
    block: Number(raw["block"]),
    timelock: address("timelock"),
    liveness: address("liveness"),
    calendar: address("calendar"),
    registry: address("registry"),
    priceAdapter: address("priceAdapter"),
    market: address("market"),
  };
}
