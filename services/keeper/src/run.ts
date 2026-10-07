import { errorText } from "@vayle/chain-facts/rpc-errors";
import type { KeeperConfig } from "./config.ts";
import { execute, type Clients } from "./execute.ts";
import { plan, type Action } from "./plan.ts";
import { readSnapshot } from "./snapshot.ts";

export interface RunResult {
  readonly sent: readonly Action[];
  readonly failed: readonly { readonly action: Action; readonly reason: string }[];
}

// One run: read, plan, act. A failed action is logged and retried by the next run.
export async function runOnce(config: KeeperConfig, clients: Clients): Promise<RunResult> {
  const actions = plan(await readSnapshot(clients.public, config));
  const failed: { action: Action; reason: string }[] = [];
  const sent: Action[] = [];
  for (const action of actions) {
    try {
      await execute(clients, config, action);
      sent.push(action);
    } catch (error) {
      const reason = errorText(error);
      console.error(`keeper: ${action.kind} failed`, reason);
      failed.push({ action, reason });
    }
  }
  return { sent, failed };
}
