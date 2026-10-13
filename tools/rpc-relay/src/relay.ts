// A local relay in front of the chain's public RPC, for forge. The public RPC's Cloudflare front
// challenges the HTTP clients forge and Node use, most of all in bursts, while it lets curl through.
// The relay sends each request with curl, at most a few at a time, and tries a challenge or a rate
// refusal again, so a fork test or a deploy script can read through it:
//   node tools/rpc-relay/src/relay.ts          then point forge at http://127.0.0.1:8547
// The upstream is RELAY_UPSTREAM, or else ROBINHOOD_RPC_URL. RELAY_PORT and RELAY_HOST change where it
// listens.
import { execFile } from "node:child_process";
import { createServer } from "node:http";

class MissingUpstream extends Error {
  override readonly name = "MissingUpstream";
}

// In a container the relay's own ROBINHOOD_RPC_URL is the upstream, while the services beside it
// point theirs at the relay, so RELAY_UPSTREAM wins when it's set.
const upstream = process.env["RELAY_UPSTREAM"] ?? process.env["ROBINHOOD_RPC_URL"];
if (upstream === undefined || upstream === "" || upstream.startsWith("http://127.0.0.1")) {
  throw new MissingUpstream("set ROBINHOOD_RPC_URL to the RPC to relay to");
}
const port = Number(process.env["RELAY_PORT"] ?? "8547");
// 127.0.0.1 on a laptop or CI runner, 0.0.0.0 inside a container so the services next to it reach it.
const host = process.env["RELAY_HOST"] ?? "127.0.0.1";
const IN_FLIGHT = 4;
const ATTEMPTS = 8;

interface Answer {
  readonly status: number;
  readonly body: string;
}

let active = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<void> {
  if (active < IN_FLIGHT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next === undefined) active--;
  else next();
}

function curl(url: string, body: string): Promise<Answer> {
  return new Promise((resolve) => {
    const child = execFile(
      "curl",
      [
        "-s",
        "-m",
        "30",
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "--data-binary",
        "@-",
        "-w",
        "\n%{http_code}",
        url,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve({ status: 599, body: "" });
          return;
        }
        const cut = stdout.lastIndexOf("\n");
        resolve({ status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) });
      },
    );
    child.stdin?.end(body);
  });
}

// A challenge (403), a rate refusal (429), a server error or a dropped connection is tried again,
// waiting a little longer each time. Any other answer goes back as it came.
async function relay(url: string, body: string): Promise<Answer> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const answer = await curl(url, body);
    const retry = answer.status === 403 || answer.status === 429 || answer.status >= 500;
    if (!retry) return answer;
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  return {
    status: 503,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "the RPC kept refusing" },
    }),
  };
}

createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    void (async () => {
      await slot();
      try {
        const answer = await relay(upstream, Buffer.concat(chunks).toString("utf8"));
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(answer.body);
      } finally {
        release();
      }
    })();
  });
}).listen(port, host, () => {
  console.log(`relaying ${host}:${String(port)} to the upstream RPC`);
});
