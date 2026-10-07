import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vayleMarketAbi } from "@vayle/abi";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  hashTypedData,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DigestMismatch } from "../src/errors.ts";
import { quoteTypedData, signedQuote, type Quote } from "../src/execute.ts";

const MARKET = "0xD372B11d62Ac2eD8E64BC8c3E2382a8e9972974B";
const CONFIG = { chainId: 4663, market: MARKET } as const;
const signer = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const TERMS = {
  series: 77n,
  premium: 4_339_500n,
  maxFeeBps: 0,
  maxAmount: 5n * 10n ** 18n,
  minFill: 10n ** 16n,
  deadline: 1_800_000_000,
};

// An RPC whose quoteDigest answers with whatever the test computes from the quote it's asked about.
function marketAnswering(digestOf: (quote: Quote) => Hex) {
  return createPublicClient({
    transport: custom({
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const [call] = params as [{ data: Hex }];
        const decoded = decodeFunctionData({ abi: vayleMarketAbi, data: call.data });
        if (decoded.functionName !== "quoteDigest")
          throw new Error(`unexpected ${decoded.functionName}`);
        const [quote] = decoded.args;
        return Promise.resolve(encodeAbiParameters([{ type: "bytes32" }], [digestOf(quote)]));
      },
    }),
  });
}

describe("signedQuote", () => {
  it("signs the quote it hashed itself when the market reports the same digest", async () => {
    // #given
    const honest = marketAnswering((quote) => hashTypedData(quoteTypedData(CONFIG, quote)));
    // #when
    const { quote, signature } = await signedQuote({ public: honest, signer }, CONFIG, TERMS);
    // #then
    const recovered = await recoverTypedDataAddress({
      ...quoteTypedData(CONFIG, quote),
      signature,
    });
    assert.equal(recovered, signer.address);
  });

  it("refuses to sign when the market reports the digest of a different quote", async () => {
    // #given
    const lying = marketAnswering(() => `0x${"ab".repeat(32)}`);
    // #when
    const attempt = signedQuote({ public: lying, signer }, CONFIG, TERMS);
    // #then
    await assert.rejects(attempt, DigestMismatch);
  });
});
