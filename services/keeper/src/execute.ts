import { livenessCheckpointAbi, vayleMarketAbi } from "@vayle/abi";
import type { Account, Chain, Hash, PublicClient, Transport, WalletClient } from "viem";
import type { KeeperConfig } from "./config.ts";
import type { Action } from "./plan.ts";

export interface Clients {
  readonly public: PublicClient;
  readonly wallet: WalletClient<Transport, Chain, Account>;
}

async function confirmed(clients: Clients, hash: Hash): Promise<Hash> {
  await clients.public.waitForTransactionReceipt({ hash });
  return hash;
}

// Simulates first, so a call that would revert is never sent, then waits for the receipt.
export async function execute(
  clients: Clients,
  config: KeeperConfig,
  action: Action,
): Promise<Hash> {
  const { account } = clients.wallet;
  const market = { address: config.market, abi: vayleMarketAbi, account } as const;
  const sim = clients.public;
  const write = clients.wallet;
  switch (action.kind) {
    case "checkpoint": {
      const { request } = await sim.simulateContract({
        address: config.liveness,
        abi: livenessCheckpointAbi,
        functionName: "checkpoint",
        account,
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "observeClose": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "observeClose",
        args: [action.asset],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "observePauses": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "observePauses",
        args: [action.asset],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "createEpoch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "createEpoch",
        args: [action.asset, action.roundHint],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "finalize": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "finalize",
        args: [action.series],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "settleOrder": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "settleOrder",
        args: [action.id],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "openBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "openBatch",
        args: [action.series],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "countBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "countBatch",
        args: [action.series, [...action.ids]],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "fillBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "fillBatch",
        args: [action.series, [...action.ids]],
      });
      return confirmed(clients, await write.writeContract(request));
    }
    case "closeBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "closeBatch",
        args: [action.series],
      });
      return confirmed(clients, await write.writeContract(request));
    }
  }
}
