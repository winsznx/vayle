import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { robinhood } from "viem/chains";
import facts from "../../../deployments/robinhood-mainnet.json" with { type: "json" };
import { robinhoodChain } from "../src/chain.ts";

describe("robinhoodChain", () => {
  it("names Multicall3 where the chain facts recorded it, so clients can batch reads", () => {
    // #given
    const recorded = facts.multicall3;
    // #when
    const multicall3 = robinhoodChain.contracts?.multicall3;
    // #then
    assert.deepEqual(multicall3, {
      address: getAddress(recorded.address),
      blockCreated: recorded.blockCreated,
    });
  });

  it("offers wallets the public RPC and explorer, never a private endpoint", () => {
    // #given
    const { publicRpcUrl, explorerUrl } = facts.chain;
    // #when
    const { rpcUrls, blockExplorers } = robinhoodChain;
    // #then
    assert.deepEqual(rpcUrls.default.http, [publicRpcUrl]);
    assert.equal(blockExplorers?.default.url, explorerUrl);
  });

  it("takes its name and currency from viem's entry for the same chain ID", () => {
    // #given
    const chainId = facts.chain.chainId;
    // #when
    const { id, name, nativeCurrency } = robinhoodChain;
    // #then
    assert.equal(robinhood.id, chainId);
    assert.equal(id, chainId);
    assert.equal(name, robinhood.name);
    assert.deepEqual(nativeCurrency, robinhood.nativeCurrency);
  });
});
