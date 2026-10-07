import type { MakerConfig } from "./config.ts";
import { execute, type Clients } from "./execute.ts";
import { priceGuard, type PriceVerdict } from "./guard.ts";
import { plan, type MakerAction } from "./plan.ts";
import { feedSessions } from "./sessions.ts";
import { readSnapshot } from "./snapshot.ts";

export interface RunResult {
  // Whether the run could bid and quote, and if not, why.
  readonly price: PriceVerdict;
  readonly sent: readonly MakerAction[];
  readonly failed: readonly { readonly action: MakerAction; readonly reason: string }[];
}

// One run: read, judge the price, plan, act. A failed action is logged and reconsidered by the
// next run.
export async function runOnce(config: MakerConfig, clients: Clients): Promise<RunResult> {
  const snapshot = await readSnapshot(clients.public, config, clients.signer.address);
  const price = priceGuard(snapshot.price, config, feedSessions, snapshot.now);
  if (!price.usable) {
    console.warn(`maker: no bids or quotes this run. ${price.reason}: ${price.detail}`);
  }
  const failed: { action: MakerAction; reason: string }[] = [];
  const sent: MakerAction[] = [];
  for (const action of plan(snapshot, config.pricing, price)) {
    try {
      await execute(clients, config, action);
      sent.push(action);
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.error(`maker: ${action.kind} failed`, reason);
      failed.push({ action, reason });
    }
  }
  return { price, sent, failed };
}
