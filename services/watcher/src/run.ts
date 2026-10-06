import type { PublicClient } from "viem";
import { EXPLORER, type WatcherConfig } from "./config.ts";
import { readEvents, type ChainEvent } from "./events.ts";
import { conditions, eventAlerts, transitions, type Alert } from "./rules.ts";
import { postAlerts } from "./sink.ts";
import { readSnapshot } from "./snapshot.ts";
import { loadState, saveState, type Fetch, type WatcherState } from "./store.ts";

// Logs are read in chunks of this many blocks, at most this many chunks a run, so a backlog drains
// over several runs instead of timing out one.
export const MAX_RANGE = 5_000n;
export const MAX_CHUNKS = 4;
export const FAILURES_BEFORE_PAGE = 5;

export interface RunDeps {
  readonly client: PublicClient;
  readonly fetch: Fetch;
}

export interface RunResult {
  readonly cursor: bigint;
  readonly alerts: number;
}

export async function runOnce(config: WatcherConfig, deps: RunDeps): Promise<RunResult> {
  const state = await loadState(config.store, deps.fetch);
  try {
    return await watch(config, deps, state);
  } catch (error) {
    await recordFailure(config, deps, state, error);
    throw error;
  }
}

async function watch(
  config: WatcherConfig,
  deps: RunDeps,
  state: WatcherState,
): Promise<RunResult> {
  const snapshot = await readSnapshot(deps.client, config);
  const events: ChainEvent[] = [];
  let cursor = snapshot.block;
  if (config.market !== null) {
    cursor = state.cursor ?? config.market.startBlock - 1n;
    for (let chunk = 0; chunk < MAX_CHUNKS && cursor < snapshot.block; chunk++) {
      const to = cursor + MAX_RANGE < snapshot.block ? cursor + MAX_RANGE : snapshot.block;
      events.push(...(await readEvents(deps.client, config.market, cursor + 1n, to)));
      cursor = to;
    }
  }
  const changes = transitions(state.active, conditions(snapshot), snapshot.now);
  const alerts: Alert[] = [...eventAlerts(events, EXPLORER), ...changes.alerts];
  if (alerts.length > 0) await postAlerts(config.webhookUrl, alerts, deps.fetch);
  await saveState(config.store, { cursor, active: changes.active, failures: 0 }, deps.fetch);
  return { cursor, alerts: alerts.length };
}

// Counts the failure and pages once when runs keep failing. Both steps are best effort: the run's
// own error is what gets rethrown.
async function recordFailure(
  config: WatcherConfig,
  deps: RunDeps,
  state: WatcherState,
  error: unknown,
): Promise<void> {
  const failures = state.failures + 1;
  try {
    await saveState(config.store, { ...state, failures }, deps.fetch);
    if (failures === FAILURES_BEFORE_PAGE) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      await postAlerts(
        config.webhookUrl,
        [
          {
            key: "watcher-failing",
            severity: "page",
            text: `The watcher failed ${failures} runs in a row. Last error: ${reason}`,
          },
        ],
        deps.fetch,
      );
    }
  } catch (secondary) {
    console.error("watcher: couldn't record the failure", secondary);
  }
}
