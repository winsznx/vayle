import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { proxyRpc, type RpcEnv } from "../worker/rpc.ts";

const PRIMARY = "https://primary.example/rpc";
const FALLBACK = "https://fallback.example/rpc";
const realFetch = globalThis.fetch;

function env(overrides: Partial<RpcEnv> = {}): RpcEnv {
  return {
    RPC_URL: PRIMARY,
    RPC_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    ...overrides,
  };
}

function request(): Request {
  return new Request("https://vayle.xyz/rpc", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://vayle.xyz" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
}

// Answers each upstream from a table and records which ones were asked.
function upstreams(answers: Record<string, number>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(url);
    const status = answers[url] ?? 500;
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status }),
    );
  };
  return asked;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("proxyRpc", () => {
  it("answers from the first RPC when it accepts the request", async () => {
    // #given
    const asked = upstreams({ [PRIMARY]: 200 });
    // #when
    const response = await proxyRpc(request(), env({ RPC_FALLBACK_URL: FALLBACK }));
    // #then
    assert.deepEqual([response.status, asked], [200, [PRIMARY]]);
  });

  it("asks the fallback when the first refuses the request as too many", async () => {
    // #given
    const asked = upstreams({ [PRIMARY]: 429, [FALLBACK]: 200 });
    // #when
    const response = await proxyRpc(request(), env({ RPC_FALLBACK_URL: FALLBACK }));
    // #then
    assert.deepEqual([response.status, asked], [200, [PRIMARY, FALLBACK]]);
  });

  it("passes the refusal on when there's no fallback", async () => {
    // #given
    const asked = upstreams({ [PRIMARY]: 429 });
    // #when
    const response = await proxyRpc(request(), env());
    // #then
    assert.deepEqual([response.status, asked], [429, [PRIMARY]]);
  });
});
