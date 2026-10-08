import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

// A JSON-RPC endpoint in memory that answers a batching client the way a node does: the latest
// block, and eth_calls of Multicall3's aggregate3, each inner call answered by a contract written
// in the test. It counts every HTTP request, which is what the RPC bills.

// What a view answers with to revert.
export class Revert {
  readonly abi: Abi;
  readonly errorName: string;
  readonly args: readonly unknown[];

  constructor(abi: Abi, errorName: string, args: readonly unknown[] = []) {
    this.abi = abi;
    this.errorName = errorName;
    this.args = args;
  }
}

// A contract's views: what each answers, or a Revert.
export interface FakeContract {
  readonly abi: Abi;
  readonly read: (functionName: string, args: readonly unknown[]) => unknown;
}

export interface FakeChain {
  readonly fetchFn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  // The JSON-RPC method of every request, in order.
  readonly requests: string[];
}

interface Call {
  readonly target: Address;
  readonly callData: Hex;
}

function answer(contracts: ReadonlyMap<string, FakeContract>, call: Call) {
  const contract = contracts.get(call.target.toLowerCase());
  if (contract === undefined) throw new Error(`no contract at ${call.target}`);
  const { functionName, args } = decodeFunctionData({ abi: contract.abi, data: call.callData });
  const result = contract.read(functionName, args ?? []);
  if (result instanceof Revert) {
    return {
      success: false,
      returnData: encodeErrorResult({
        abi: result.abi,
        errorName: result.errorName,
        args: result.args,
      }),
    };
  }
  return {
    success: true,
    returnData: encodeFunctionResult({ abi: contract.abi, functionName, result }),
  };
}

function rpcBody(init: RequestInit | undefined): {
  id: unknown;
  method: string;
  params: unknown[];
} {
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  if (typeof body !== "object" || body === null || !("method" in body) || !("id" in body)) {
    throw new Error("not a JSON-RPC request");
  }
  const params = "params" in body && Array.isArray(body.params) ? (body.params as unknown[]) : [];
  return { id: body.id, method: String(body.method), params };
}

export function fakeChain(
  block: { readonly number: bigint; readonly timestamp: number },
  contracts: ReadonlyMap<string, FakeContract>,
): FakeChain {
  const requests: string[] = [];
  const fetchFn = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { id, method, params } = rpcBody(init);
    requests.push(method);
    let result: unknown;
    if (method === "eth_getBlockByNumber") {
      result = {
        number: numberToHex(block.number),
        timestamp: numberToHex(block.timestamp),
        hash: numberToHex(block.number, { size: 32 }),
        transactions: [],
      };
    } else if (method === "eth_call") {
      const [request] = params as [{ data: Hex }];
      const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: request.data });
      if (functionName !== "aggregate3") throw new Error(`unexpected ${functionName}`);
      const [calls] = args;
      result = encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: calls.map((call) => answer(contracts, call)),
      });
    } else {
      throw new Error(`unexpected ${method}`);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchFn, requests };
}

// The contracts keyed the way fakeChain looks them up.
export function byAddress(
  entries: readonly (readonly [Address, FakeContract])[],
): Map<string, FakeContract> {
  return new Map(entries.map(([address, contract]) => [address.toLowerCase(), contract]));
}
