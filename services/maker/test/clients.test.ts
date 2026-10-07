import assert from "node:assert/strict";
import { describe, it } from "node:test";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { makerClients } from "../src/clients.ts";

// Building clients sends nothing, so the URL is never called.
const RPC = "https://rpc.invalid/maker";

describe("makerClients", () => {
  it("batches reads through the chain facts' Multicall3, 32 KiB of calls at a time", () => {
    // #given
    const key = generatePrivateKey();
    // #when
    const { public: reads } = makerClients({ rpcUrl: RPC, key });
    // #then
    assert.deepEqual(
      [reads.chain?.id, reads.chain?.contracts?.multicall3?.address, reads.batch?.multicall],
      [facts.chain.chainId, getAddress(facts.multicall3.address), { batchSize: 16_384 }],
    );
  });

  it("sends from the maker's key through the RPC it reads from", () => {
    // #given
    const key = generatePrivateKey();
    // #when
    const { public: reads, wallet } = makerClients({ rpcUrl: RPC, key });
    // #then
    assert.deepEqual(
      [reads.transport.url, wallet.transport.url, wallet.account.address],
      [RPC, RPC, privateKeyToAddress(key)],
    );
  });
});
