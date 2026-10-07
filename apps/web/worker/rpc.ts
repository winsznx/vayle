// The site's own RPC endpoint. The browser reads the chain through /rpc, and the Worker forwards
// each request to the private RPC whose URL, key included, is a Worker secret, so the key never
// ships in the site's JavaScript. Only the read methods the app uses pass, only from the site's
// own pages, and log queries only for the market and the feed.

export interface RpcEnv {
  // The private RPC's URL, set with `wrangler secret put RPC_URL`.
  readonly RPC_URL?: string;
  // Addresses eth_getLogs may ask about, comma-separated.
  readonly RPC_LOG_ADDRESSES?: string;
}

const READ_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_getBalance",
  "eth_getCode",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
]);

// Large enough for a busy batch of multicalls, small enough that nobody streams megabytes through.
const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH = 50;
// The widest log query one request may make. The app reads its history in chunks under this.
const MAX_LOG_BLOCKS = 50_000n;

interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: unknown;
  readonly method: string;
  readonly params?: unknown;
}

function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["jsonrpc"] === "2.0" && typeof v["method"] === "string";
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function blockOf(tag: unknown): bigint | null {
  if (typeof tag !== "string" || !/^0x[0-9a-f]+$/i.test(tag)) return null;
  return BigInt(tag);
}

// Why a request may not pass, or null when it may.
function refusal(request: RpcRequest, logAddresses: ReadonlySet<string>): string | null {
  if (!READ_METHODS.has(request.method)) return `${request.method} isn't available here`;
  if (request.method !== "eth_getLogs") return null;
  const [filter] = Array.isArray(request.params) ? (request.params as unknown[]) : [];
  if (typeof filter !== "object" || filter === null) return "eth_getLogs needs a filter";
  const { address, fromBlock, toBlock, blockHash } = filter as Record<string, unknown>;
  const addresses = Array.isArray(address) ? address : [address];
  if (
    addresses.length === 0 ||
    !addresses.every((a) => typeof a === "string" && logAddresses.has(a.toLowerCase()))
  ) {
    return "eth_getLogs only reads the market and the feed";
  }
  if (blockHash !== undefined) return null;
  const from = blockOf(fromBlock);
  const to = blockOf(toBlock);
  if (from === null || to === null) return "eth_getLogs needs numeric fromBlock and toBlock";
  if (to < from || to - from >= MAX_LOG_BLOCKS) {
    return `eth_getLogs spans at most ${MAX_LOG_BLOCKS.toString()} blocks`;
  }
  return null;
}

export async function proxyRpc(request: Request, env: RpcEnv): Promise<Response> {
  if (request.method !== "POST") return json(rpcError(null, -32600, "POST JSON-RPC here"), 405);
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return json(rpcError(null, -32600, "this endpoint serves this site only"), 403);
  }
  if (env.RPC_URL === undefined || env.RPC_URL === "") {
    return json(rpcError(null, -32603, "the site's RPC isn't configured"), 503);
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json(rpcError(null, -32600, "request too large"), 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(rpcError(null, -32600, "request too large"), 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, "not JSON"), 400);
  }
  const batch = Array.isArray(body);
  const requests: readonly unknown[] = Array.isArray(body) ? body : [body];
  if (requests.length === 0 || requests.length > MAX_BATCH) {
    return json(
      rpcError(null, -32600, `send 1 to ${MAX_BATCH.toString()} requests at a time`),
      400,
    );
  }
  const logAddresses = new Set(
    (env.RPC_LOG_ADDRESSES ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a !== ""),
  );
  for (const r of requests) {
    if (!isRpcRequest(r)) return json(rpcError(null, -32600, "not a JSON-RPC 2.0 request"), 400);
    const reason = refusal(r, logAddresses);
    if (reason !== null)
      return json(batch ? [rpcError(r.id, -32601, reason)] : rpcError(r.id, -32601, reason), 400);
  }

  const upstream = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: text,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
