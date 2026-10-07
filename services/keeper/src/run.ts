import type { KeeperConfig } from "./config.ts";
import { execute, type Clients } from "./execute.ts";
import { plan, type Action } from "./plan.ts";
import { readSnapshot } from "./snapshot.ts";

export interface RunResult {
  readonly sent: number;
  readonly failed: readonly { readonly action: Action; readonly reason: string }[];
}

// One run: read, plan, act. A failed action is logged and retried by the next run.
export async function runOnce(config: KeeperConfig, clients: Clients): Promise<RunResult> {
  const actions = plan(await readSnapshot(clients.public, config));
  const failed: { action: Action; reason: string }[] = [];
  let sent = 0;
  for (const action of actions) {
    try {
      await execute(clients, config, action);
      sent++;
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`keeper: ${action.kind} failed`, reason);
      failed.push({ action, reason });
    }
  }
  return { sent, failed };
}
