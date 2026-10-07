import type { MakerConfig } from "./config.ts";
import { execute, type Clients } from "./execute.ts";
import { plan, type MakerAction } from "./plan.ts";
import { readSnapshot } from "./snapshot.ts";

export interface RunResult {
  readonly sent: number;
  readonly failed: readonly { readonly action: MakerAction; readonly reason: string }[];
}

// One run: read, plan, act. A failed action is logged and reconsidered by the next run.
export async function runOnce(config: MakerConfig, clients: Clients): Promise<RunResult> {
  const snapshot = await readSnapshot(clients.public, config, clients.signer.address);
  const failed: { action: MakerAction; reason: string }[] = [];
  let sent = 0;
  for (const action of plan(snapshot, config.pricing)) {
    try {
      await execute(clients, config, action);
      sent++;
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`maker: ${action.kind} failed`, reason);
      failed.push({ action, reason });
    }
  }
  return { sent, failed };
}
