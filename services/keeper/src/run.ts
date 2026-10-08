import { errorText } from "@vayle/chain-facts/rpc-errors";
import type { KeeperConfig } from "./config.ts";
import { execute, type Clients } from "./execute.ts";
import { plan, type Action } from "./plan.ts";
import { readSnapshot, type MarketNote } from "./snapshot.ts";

export interface RunResult {
  readonly sent: readonly Action[];
  readonly failed: readonly { readonly action: Action; readonly reason: string }[];
  // Markets left out of the run, or missing a read, and why.
  readonly notes: readonly MarketNote[];
}

// One run: read, plan, act. A failed action is logged and retried by the next run, and a market
// left out is logged with the reason.
export async function runOnce(config: KeeperConfig, clients: Clients): Promise<RunResult> {
  const { snapshot, notes } = await readSnapshot(clients.public, config);
  for (const note of notes) console.warn(`keeper: ${note.symbol} ${note.text}`);
  const failed: { action: Action; reason: string }[] = [];
  const sent: Action[] = [];
  for (const action of plan(snapshot)) {
    try {
      await execute(clients, config, action);
      sent.push(action);
    } catch (error) {
      const reason = errorText(error);
      console.error(`keeper: ${action.kind} failed`, reason);
      failed.push({ action, reason });
    }
  }
  return { sent, failed, notes };
}
