import { livenessCheckpointAbi, vayleMarketAbi } from "@vayle/abi";
import { withGasMargin } from "@vayle/market";
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

type Request = Parameters<Clients["wallet"]["writeContract"]>[0];

// Sends with a gas limit over the estimate, since what a call costs depends on the second it
// lands in (withGasMargin).
async function sent(clients: Clients, request: Request): Promise<Hash> {
  const { address, abi, functionName, args } = request;
  const gas = withGasMargin(
    await clients.public.estimateContractGas({
      address,
      abi,
      functionName,
      account: clients.wallet.account,
      ...(args === undefined ? {} : { args }),
    }),
  );
  return confirmed(clients, await clients.wallet.writeContract({ ...request, gas }));
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
  switch (action.kind) {
    case "checkpoint": {
      const { request } = await sim.simulateContract({
        address: config.liveness,
        abi: livenessCheckpointAbi,
        functionName: "checkpoint",
        account,
      });
      return sent(clients, request);
    }
    case "observeClose": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "observeClose",
        args: [action.asset],
      });
      return sent(clients, request);
    }
    case "observePauses": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "observePauses",
        args: [action.asset],
      });
      return sent(clients, request);
    }
    case "createEpoch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "createEpoch",
        args: [action.asset, action.roundHint],
      });
      return sent(clients, request);
    }
    case "finalize": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "finalize",
        args: [action.series],
      });
      return sent(clients, request);
    }
    case "settleOrder": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "settleOrder",
        args: [action.id],
      });
      return sent(clients, request);
    }
    case "openBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "openBatch",
        args: [action.series],
      });
      return sent(clients, request);
    }
    case "countBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "countBatch",
        args: [action.series, [...action.ids]],
      });
      return sent(clients, request);
    }
    case "fillBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "fillBatch",
        args: [action.series, [...action.ids]],
      });
      return sent(clients, request);
    }
    case "closeBatch": {
      const { request } = await sim.simulateContract({
        ...market,
        functionName: "closeBatch",
        args: [action.series],
      });
      return sent(clients, request);
    }
  }
}
