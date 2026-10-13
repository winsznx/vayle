import { errorText } from "@vayle/chain-facts/rpc-errors";
import { watcherClient } from "./clients.ts";
import { loadConfig } from "./config.ts";
import { runOnce } from "./run.ts";

// The same watcher as a long-running Node process, for a server instead of a Worker: a run every
// minute, never two at once.
//   node --env-file=.env src/node.ts

const RUN_EVERY_MS = 60_000;

const config = loadConfig(process.env);
const client = watcherClient(config.rpcUrl);

let stopping = false;
let timer: NodeJS.Timeout | null = null;

async function run(): Promise<void> {
  try {
    const result = await runOnce(config, { client, fetch: (input, init) => fetch(input, init) });
    console.log(
      `watched through block ${result.cursor.toString()}, ${result.alerts.toString()} alerts`,
    );
  } catch (error) {
    console.error("watcher run failed, retrying next minute:", errorText(error));
  }
  if (!stopping) timer = setTimeout(() => void run(), RUN_EVERY_MS);
}

function stop(): void {
  stopping = true;
  if (timer !== null) clearTimeout(timer);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
void run();
