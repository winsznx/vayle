import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handle } from "./api.ts";
import { loadConfig } from "./config.ts";
import { LogRangeRefused } from "./errors.ts";
import { apiDeps, chainClient, indexOnce } from "./indexing.ts";

// The same indexer as a long-running Node process, for a server instead of a Worker: a pass every
// minute, never two at once, and the API on PORT.
//   node --env-file=.env src/node.ts

const PASS_EVERY_MS = 60_000;

const config = loadConfig(process.env);
const client = chainClient(config.rpcUrl);
const deps = apiDeps(config);
const port = Number(process.env["PORT"] ?? "8787");

let stopping = false;
let timer: NodeJS.Timeout | null = null;

async function pass(): Promise<void> {
  try {
    const cursor = await indexOnce(config, client);
    console.log(`indexed through block ${cursor.toString()}`);
  } catch (error) {
    if (error instanceof LogRangeRefused) {
      // Every later pass would send the same request and be refused the same way.
      console.error(`indexing stopped, the API keeps serving: ${error.message}`);
      return;
    }
    console.error("indexing pass failed, retrying next pass:", error);
  }
  if (!stopping) timer = setTimeout(() => void pass(), PASS_EVERY_MS);
}

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const response = await handle(new Request(url, { method: req.method ?? "GET" }), deps);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  } catch (error) {
    console.error("request failed:", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "the indexer couldn't answer" }));
  }
}

const server = createServer((req, res) => void serve(req, res));
server.listen(port, () => {
  console.log(`indexer API on port ${port.toString()}`);
});
void pass();

function stop(): void {
  stopping = true;
  if (timer !== null) clearTimeout(timer);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
