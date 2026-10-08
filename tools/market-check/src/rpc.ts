import { robinhoodChain } from "@vayle/chain-facts/chain";
import { errorText } from "@vayle/chain-facts/rpc-errors";
import {
  createPublicClient,
  decodeErrorResult,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { MissingRpcUrl } from "./errors.ts";

// Every chain read goes through one RPC URL, one HTTP request per call, and the run counts them,
// because the RPC bills per call whatever a call carries. Contract reads go through Multicall3's
// aggregate3 at one pinned block, many to a call. Errors are logged through errorText, which cuts
// every URL to its origin, since the RPC's key sits in its URL.

// A busy RPC answers 429. viem waits 1, 2, 4 and 8 s between tries, or what the RPC's Retry-After
// asks for. Every try is a billed call.
const RETRIES = 4;
const RETRY_DELAY_MS = 1_000;
// An aggregate3 of a thousand cold reads can take the archive node well over viem's default 10 s.
const TIMEOUT_MS = 60_000;
// A call the node refuses or can't finish for these reasons can go through as smaller calls.
const SPLITTABLE = /gas|too large|size limit|took too long|timed out/i;
// Calls in flight at once, so a long run doesn't trip the RPC's rate limit.
const CONCURRENCY = 4;

// aggregate3 is payable on chain. It's declared view here, as viem's own copy does, since the run
// only ever sends it as an eth_call.
const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);

export interface Call {
  readonly target: Address;
  readonly data: Hex;
}

// A read the chain answered with a revert is "reverted". One the run couldn't make, because the
// RPC failed or refused the whole call, is "unavailable".
export type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "reverted" | "unavailable"; readonly error: string };

export interface Probe<T> {
  readonly call: Call;
  readonly decode: (data: Hex) => T;
}

export interface Handle<T> {
  readonly read: () => Read<T>;
}

export interface BatchOptions {
  // Reads per aggregate3 call, sized to the node's eth_call gas cap.
  readonly perCall: number;
  // Quotes can starve each other of gas inside one call, and a starved one reverts without data.
  // With this set, such reads are tried again one to a call.
  readonly retryEmptyReverts?: boolean;
}

function revertText(data: Hex): string {
  if (data === "0x") return "reverted without data";
  try {
    const decoded = decodeErrorResult({ abi: [], data });
    return `reverted: ${decoded.errorName}(${decoded.args.map(String).join(", ")})`;
  } catch {
    return `reverted with ${data.slice(0, 10)}`;
  }
}

interface Item {
  readonly call: Call;
  readonly settle: (result: Read<Hex>) => void;
}

export class Rpc {
  readonly client: PublicClient;
  readonly blockNumber: bigint;
  readonly #counter: { calls: number };
  #retried = 0;
  #unavailable = 0;
  #firstUnavailable: string | null = null;

  private constructor(client: PublicClient, counter: { calls: number }, blockNumber: bigint) {
    this.client = client;
    this.#counter = counter;
    this.blockNumber = blockNumber;
  }

  // Connects and pins the latest block. Every read after this is at that block.
  static async connect(
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<{ rpc: Rpc; timestamp: number }> {
    const url = env["ROBINHOOD_RPC_URL"];
    if (url === undefined || url === "") {
      throw new MissingRpcUrl("set ROBINHOOD_RPC_URL in the repo's .env");
    }
    const counter = { calls: 0 };
    const counting: typeof fetch = (input, init) => {
      counter.calls++;
      return fetch(input, init);
    };
    const client = createPublicClient({
      chain: robinhoodChain,
      transport: http(url, {
        fetchFn: counting,
        retryCount: RETRIES,
        retryDelay: RETRY_DELAY_MS,
        timeout: TIMEOUT_MS,
      }),
    });
    const block = await client.getBlock({ blockTag: "latest" });
    return {
      rpc: new Rpc(client, counter, block.number),
      timestamp: Number(block.timestamp),
    };
  }

  get calls(): number {
    return this.#counter.calls;
  }

  // Reads sent again on their own after reverting without data inside a shared call.
  get retried(): number {
    return this.#retried;
  }

  countRetries(count: number): void {
    this.#retried += count;
  }

  // Reads the run couldn't make at all, and the first reason, so a degraded run says so.
  get unavailable(): { readonly count: number; readonly first: string | null } {
    return { count: this.#unavailable, first: this.#firstUnavailable };
  }

  countUnavailable(count: number, error: string): void {
    this.#unavailable += count;
    this.#firstUnavailable ??= error;
  }

  batch(options: BatchOptions): Batch {
    return new Batch(this, options);
  }

  // One aggregate3 call over `calls` at the pinned block.
  async aggregate(calls: readonly Call[]): Promise<readonly { success: boolean; data: Hex }[]> {
    const results = await this.client.readContract({
      address: getAddress(robinhoodChain.contracts?.multicall3?.address ?? "0x"),
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))],
      blockNumber: this.blockNumber,
    });
    return results.map((r) => ({ success: r.success, data: r.returnData }));
  }
}

// Reads collected first and sent together. Each add() returns a handle that holds the read once
// run() has finished.
export class Batch {
  readonly #rpc: Rpc;
  readonly #options: BatchOptions;
  readonly #items: Item[] = [];
  #starved: Item[] = [];

  constructor(rpc: Rpc, options: BatchOptions) {
    this.#rpc = rpc;
    this.#options = options;
  }

  get size(): number {
    return this.#items.length;
  }

  add<T>(probe: Probe<T>): Handle<T> {
    let slot: Read<T> | null = null;
    this.#items.push({
      call: probe.call,
      settle: (result) => {
        if (!result.ok) {
          slot = result;
          return;
        }
        try {
          slot = { ok: true, value: probe.decode(result.value) };
        } catch (error) {
          slot = { ok: false, kind: "reverted", error: `undecodable answer: ${errorText(error)}` };
        }
      },
    });
    return {
      read: () => {
        if (slot === null) throw new Error("read before its batch ran");
        return slot;
      },
    };
  }

  async run(): Promise<void> {
    const chunks: Item[][] = [];
    for (let i = 0; i < this.#items.length; i += this.#options.perCall) {
      chunks.push(this.#items.slice(i, i + this.#options.perCall));
    }
    await inParallel(chunks, CONCURRENCY, (chunk) => this.#send(chunk));
    if (this.#options.retryEmptyReverts === true) {
      const starved = this.#starved;
      this.#starved = [];
      this.#rpc.countRetries(starved.length);
      await inParallel(starved, CONCURRENCY, (item) => this.#send([item], false));
    }
  }

  // Sends one call. If the node refuses the call for its gas or the size of its answer, it splits
  // the chunk in two and tries each half, down to single reads. Any other failure, like the RPC
  // being down, marks the chunk's reads unavailable without sending more.
  async #send(chunk: readonly Item[], collectStarved = true): Promise<void> {
    let results: readonly { success: boolean; data: Hex }[];
    try {
      results = await this.#rpc.aggregate(chunk.map((item) => item.call));
    } catch (error) {
      if (chunk.length > 1 && SPLITTABLE.test(errorText(error))) {
        const half = Math.ceil(chunk.length / 2);
        await this.#send(chunk.slice(0, half), collectStarved);
        await this.#send(chunk.slice(half), collectStarved);
        return;
      }
      const text = errorText(error);
      this.#rpc.countUnavailable(chunk.length, text);
      for (const item of chunk) item.settle({ ok: false, kind: "unavailable", error: text });
      return;
    }
    for (const [i, item] of chunk.entries()) {
      const result = results[i];
      if (result === undefined) {
        item.settle({ ok: false, kind: "unavailable", error: "missing from the call's answer" });
      } else if (result.success) {
        item.settle({ ok: true, value: result.data });
      } else if (
        collectStarved &&
        this.#options.retryEmptyReverts === true &&
        result.data === "0x" &&
        chunk.length > 1
      ) {
        this.#starved.push(item);
      } else {
        item.settle({ ok: false, kind: "reverted", error: revertText(result.data) });
      }
    }
  }
}

export async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await work(item);
    }
  });
  await Promise.all(lanes);
}
