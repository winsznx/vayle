import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import type { MarketEvent } from "@vayle/market";
import { encodeAbiParameters, encodeEventTopics, numberToHex, type Address, type Hex } from "viem";
import type { IndexerConfig } from "../src/config.ts";
import { LogRangeRefused } from "../src/errors.ts";
import { chainClient, indexOnce } from "../src/indexing.ts";
import type { Fetch } from "../src/store.ts";

const MARKET: Address = "0x00000000000000000000000000000000000000aa";
const OWNER: Address = "0x00000000000000000000000000000000000000bb";
const TOKEN: Address = "0x00000000000000000000000000000000000000cc";
// A block time the production RPC put on a log on 2026-10-07.
const TIME = 1_791_397_844;

const CONFIG: IndexerConfig = {
  rpcUrl: "https://rpc.example",
  store: { url: "https://store.example", serviceKey: "service-key" },
  chainId: 4663,
  market: MARKET,
  startBlock: 1_000_001n,
};

// A log as it travels over JSON-RPC.
interface RpcLog {
  readonly address: Address;
  readonly blockHash: Hex;
  readonly blockNumber: Hex;
  readonly data: Hex;
  readonly logIndex: Hex;
  readonly removed: boolean;
  readonly topics: readonly Hex[];
  readonly transactionHash: Hex;
  readonly transactionIndex: Hex;
  readonly blockTimestamp?: Hex;
}

// A Credited event from the market in `block`. With `time`, the log carries blockTimestamp, as
// every log from the production RPC does.
function credited(block: bigint, logIndex: number, time?: number): RpcLog {
  const topics = encodeEventTopics({
    abi: vayleMarketAbi,
    eventName: "Credited",
    args: { owner: OWNER, token: TOKEN },
  }).filter((t): t is Hex => typeof t === "string");
  return {
    address: MARKET,
    blockHash: numberToHex(block, { size: 32 }),
    blockNumber: numberToHex(block),
    data: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]),
    logIndex: numberToHex(logIndex),
    removed: false,
    topics,
    transactionHash: numberToHex(block * 1_000n + BigInt(logIndex), { size: 32 }),
    transactionIndex: "0x0",
    ...(time === undefined ? {} : { blockTimestamp: numberToHex(time) }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RpcCall {
  readonly method: string;
  readonly params: readonly unknown[];
}

// viem leaves params out of a request that has none, like eth_blockNumber.
function rpcCall(body: unknown): RpcCall & { readonly id: unknown } {
  if (typeof body !== "object" || body === null || !("method" in body) || !("id" in body)) {
    throw new Error("not a JSON-RPC request");
  }
  const { id, method } = body;
  if (typeof method !== "string") throw new Error("not a JSON-RPC request");
  const params: readonly unknown[] =
    "params" in body && Array.isArray(body.params) ? body.params : [];
  return { id, method, params };
}

function logFilter(params: readonly unknown[]): { address: string; from: bigint; to: bigint } {
  const [filter] = params;
  if (
    typeof filter !== "object" ||
    filter === null ||
    !("address" in filter) ||
    !("fromBlock" in filter) ||
    !("toBlock" in filter) ||
    typeof filter.address !== "string" ||
    typeof filter.fromBlock !== "string" ||
    typeof filter.toBlock !== "string"
  ) {
    throw new Error("eth_getLogs without an address and a block range");
  }
  return { address: filter.address, from: BigInt(filter.fromBlock), to: BigInt(filter.toBlock) };
}

interface FakeRpcOptions {
  // The widest toBlock - fromBlock served. The production RPC's is 10,000.
  readonly limit?: bigint;
  // The code that comes with the refusal. The production RPC's is -32614.
  readonly refusalCode?: number;
  // Answers for eth_getBlockByNumber, for blocks whose logs come without a time.
  readonly blockTimes?: ReadonlyMap<bigint, number>;
  // How many eth_getLogs requests get a 503 before they're served.
  readonly unavailable?: number;
}

// A JSON-RPC endpoint in memory that answers as the production RPC does, its refusal of a range
// that's too wide included: HTTP 413 with a JSON-RPC error. Every request is recorded.
function fakeRpc(latest: bigint, logs: readonly RpcLog[], options: FakeRpcOptions = {}) {
  const { limit = 10_000n, refusalCode = -32614, blockTimes = new Map<bigint, number>() } = options;
  let unavailable = options.unavailable ?? 0;
  const calls: RpcCall[] = [];
  const fetchFn = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { id, method, params } = rpcCall(
      typeof init?.body === "string" ? JSON.parse(init.body) : null,
    );
    calls.push({ method, params });
    const answer = (result: unknown): Promise<Response> =>
      Promise.resolve(jsonResponse({ jsonrpc: "2.0", id, result }));
    if (method === "eth_blockNumber") return answer(numberToHex(latest));
    if (method === "eth_getLogs") {
      const { address, from, to } = logFilter(params);
      if (to - from > limit) {
        const message = `eth_getLogs is limited to a ${limit.toLocaleString("en-US")} range`;
        return Promise.resolve(
          jsonResponse({ jsonrpc: "2.0", id, error: { code: refusalCode, message } }, 413),
        );
      }
      if (unavailable > 0) {
        unavailable--;
        return Promise.resolve(new Response("upstream unavailable", { status: 503 }));
      }
      return answer(
        logs.filter((l) => {
          const block = BigInt(l.blockNumber);
          return l.address.toLowerCase() === address.toLowerCase() && block >= from && block <= to;
        }),
      );
    }
    if (method === "eth_getBlockByNumber") {
      const [tag] = params;
      const number = typeof tag === "string" ? BigInt(tag) : -1n;
      const time = blockTimes.get(number);
      return answer(
        time === undefined
          ? null
          : {
              number: numberToHex(number),
              hash: numberToHex(number, { size: 32 }),
              timestamp: numberToHex(time),
              transactions: [],
            },
      );
    }
    return Promise.reject(new Error(`unexpected RPC method ${method}`));
  };
  const named = (method: string): RpcCall[] => calls.filter((c) => c.method === method);
  return {
    client: chainClient(CONFIG.rpcUrl, fetchFn),
    count: (method: string): number => named(method).length,
    ranges: (): [bigint, bigint][] =>
      named("eth_getLogs").map(({ params }) => {
        const { from, to } = logFilter(params);
        return [from, to];
      }),
    blocksLookedUp: (): bigint[] =>
      named("eth_getBlockByNumber").map(({ params }) =>
        typeof params[0] === "string" ? BigInt(params[0]) : -1n,
      ),
  };
}

function isCursorRow(value: unknown): value is { cursor_block: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "cursor_block" in value &&
    typeof value.cursor_block === "string"
  );
}

interface FakeStore {
  readonly fetchFn: Fetch;
  readonly rows: MarketEvent[];
  // Every cursor written, in order.
  readonly saved: string[];
}

// market_events and indexer_state as the indexer reaches them through Supabase's REST API, in
// memory.
function fakeStore(cursor: bigint | null): FakeStore {
  const rows: MarketEvent[] = [];
  const saved: string[] = [];
  let current = cursor;
  const fetchFn: Fetch = (input, init) => {
    const { pathname } = new URL(input);
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (pathname === "/rest/v1/indexer_state" && method === "GET") {
      return Promise.resolve(
        jsonResponse(current === null ? [] : [{ cursor_block: current.toString() }]),
      );
    }
    if (pathname === "/rest/v1/market_events" && method === "POST" && Array.isArray(body)) {
      rows.push(...(body as MarketEvent[]));
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    if (pathname === "/rest/v1/indexer_state" && method === "POST" && isCursorRow(body)) {
      current = BigInt(body.cursor_block);
      saved.push(body.cursor_block);
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    return Promise.reject(new Error(`unexpected store request ${method} ${pathname}`));
  };
  return { fetchFn, rows, saved };
}

function stored(rows: readonly MarketEvent[]): [number, number, string][] {
  return rows.map((r) => [r.block_number, r.log_index, r.block_time]);
}

function iso(time: number): string {
  return new Date(time * 1000).toISOString();
}

describe("indexOnce", () => {
  it("reads 10,000 blocks a request, four requests a pass at most, and saves after each", async () => {
    // #given: the chain is 100,000 blocks past the saved cursor
    const rpc = fakeRpc(1_100_000n, []);
    const store = fakeStore(1_000_000n);
    // #when
    const cursor = await indexOnce(CONFIG, rpc.client, store.fetchFn);
    // #then
    assert.deepEqual(
      [rpc.ranges(), store.saved, cursor],
      [
        [
          [1_000_001n, 1_010_000n],
          [1_010_001n, 1_020_000n],
          [1_020_001n, 1_030_000n],
          [1_030_001n, 1_040_000n],
        ],
        ["1010000", "1020000", "1030000", "1040000"],
        1_040_000n,
      ],
    );
  });

  it("starts at the deploy block and stops at the chain's latest block", async () => {
    // #given: nothing saved yet
    const rpc = fakeRpc(1_012_345n, []);
    const store = fakeStore(null);
    // #when
    await indexOnce(CONFIG, rpc.client, store.fetchFn);
    // #then
    assert.deepEqual(
      [rpc.ranges(), store.saved],
      [
        [
          [1_000_001n, 1_010_000n],
          [1_010_001n, 1_012_345n],
        ],
        ["1010000", "1012345"],
      ],
    );
  });

  it("takes block times from the logs without asking for a block", async () => {
    // #given
    const rpc = fakeRpc(1_000_100n, [
      credited(1_000_010n, 0, TIME),
      credited(1_000_010n, 1, TIME),
      credited(1_000_050n, 0, TIME + 4),
    ]);
    const store = fakeStore(1_000_000n);
    // #when
    await indexOnce(CONFIG, rpc.client, store.fetchFn);
    // #then
    assert.deepEqual(
      [stored(store.rows), rpc.count("eth_getBlockByNumber")],
      [
        [
          [1_000_010, 0, iso(TIME)],
          [1_000_010, 1, iso(TIME)],
          [1_000_050, 0, iso(TIME + 4)],
        ],
        0,
      ],
    );
  });

  it("looks up only the blocks whose logs came without a time, each once", async () => {
    // #given: block 1,000,010's log carries its time, and the logs of the two after it don't
    const rpc = fakeRpc(
      1_000_100n,
      [
        credited(1_000_010n, 0, TIME),
        credited(1_000_020n, 0),
        credited(1_000_020n, 1),
        credited(1_000_030n, 0),
      ],
      {
        blockTimes: new Map([
          [1_000_020n, TIME + 1],
          [1_000_030n, TIME + 2],
        ]),
      },
    );
    const store = fakeStore(1_000_000n);
    // #when
    await indexOnce(CONFIG, rpc.client, store.fetchFn);
    // #then
    assert.deepEqual(
      [rpc.blocksLookedUp(), stored(store.rows)],
      [
        [1_000_020n, 1_000_030n],
        [
          [1_000_010, 0, iso(TIME)],
          [1_000_020, 0, iso(TIME + 1)],
          [1_000_020, 1, iso(TIME + 1)],
          [1_000_030, 0, iso(TIME + 2)],
        ],
      ],
    );
  });

  it("stops on a range the RPC refuses as too wide, without retrying it or moving the cursor", async () => {
    // #given: the RPC's limit has dropped under the indexer's range
    const rpc = fakeRpc(1_100_000n, [credited(1_000_010n, 0, TIME)], { limit: 5_000n });
    const store = fakeStore(1_000_000n);
    // #when
    const failure = await indexOnce(CONFIG, rpc.client, store.fetchFn).then(
      () => null,
      (error: unknown) => error,
    );
    // #then
    assert.deepEqual(
      [
        failure instanceof LogRangeRefused ? failure.message : failure,
        rpc.count("eth_getLogs"),
        store.saved,
        store.rows.length,
      ],
      [
        "the RPC refused blocks 1000001 to 1010000: eth_getLogs is limited to a 5,000 range",
        1,
        [],
        0,
      ],
    );
  });

  it("knows the refusal by its words, whatever code comes with it", async () => {
    // #given: the same words with a code providers do document
    const rpc = fakeRpc(1_100_000n, [], { limit: 5_000n, refusalCode: -32602 });
    const store = fakeStore(1_000_000n);
    // #when
    const attempt = indexOnce(CONFIG, rpc.client, store.fetchFn);
    // #then
    await assert.rejects(attempt, LogRangeRefused);
  });

  it("still retries a failure that can pass, like a 503", async () => {
    // #given: the RPC is unavailable for one eth_getLogs
    const rpc = fakeRpc(1_000_100n, [credited(1_000_010n, 0, TIME)], { unavailable: 1 });
    const store = fakeStore(1_000_000n);
    // #when
    const cursor = await indexOnce(CONFIG, rpc.client, store.fetchFn);
    // #then
    assert.deepEqual([cursor, rpc.count("eth_getLogs"), store.rows.length], [1_000_100n, 2, 1]);
  });
});
