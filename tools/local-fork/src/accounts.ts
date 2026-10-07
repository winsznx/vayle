import { readFileSync, writeFileSync } from "node:fs";
import { getAddress, isHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { ForkNotRunning } from "./errors.ts";
import { ACCOUNTS_FILE } from "./paths.ts";

export const ROLES = ["deployer", "guardian", "treasury", "keeper", "maker", "holder"] as const;
export type Role = (typeof ROLES)[number];

// Fresh keys for every fork, worthless anywhere else, and a stand-in multisig address.
export interface Accounts {
  readonly multisig: Address;
  readonly keys: Readonly<Record<Role, Hex>>;
}

export function newAccounts(): Accounts {
  return {
    multisig: privateKeyToAddress(generatePrivateKey()),
    keys: {
      deployer: generatePrivateKey(),
      guardian: generatePrivateKey(),
      treasury: generatePrivateKey(),
      keeper: generatePrivateKey(),
      maker: generatePrivateKey(),
      holder: generatePrivateKey(),
    },
  };
}

export function addressOf(accounts: Accounts, role: Role): Address {
  return privateKeyToAddress(accounts.keys[role]);
}

export function saveAccounts(accounts: Accounts): void {
  writeFileSync(ACCOUNTS_FILE, `${JSON.stringify(accounts, null, 2)}\n`);
}

function key(keys: Readonly<Record<string, unknown>>, role: Role): Hex {
  const value = keys[role];
  if (typeof value !== "string" || !isHex(value) || value.length !== 66) {
    throw new ForkNotRunning(`${ACCOUNTS_FILE} has no ${role} key; run pnpm fork up again`);
  }
  return value;
}

export function readAccounts(): Accounts {
  const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8")) as {
    multisig?: unknown;
    keys?: Readonly<Record<string, unknown>>;
  };
  const keys = raw.keys ?? {};
  return {
    multisig: getAddress(String(raw.multisig)),
    keys: {
      deployer: key(keys, "deployer"),
      guardian: key(keys, "guardian"),
      treasury: key(keys, "treasury"),
      keeper: key(keys, "keeper"),
      maker: key(keys, "maker"),
      holder: key(keys, "holder"),
    },
  };
}
