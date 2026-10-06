import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toFunctionSelector } from "viem";
import { erc8056InterfaceIds, interfaceId } from "../src/erc8056.ts";

describe("interfaceId", () => {
  it("equals the selector for a single-function interface", () => {
    // #given
    const signature = "uiMultiplier()";
    // #when
    const id = interfaceId([signature]);
    // #then
    assert.equal(id, toFunctionSelector(`function ${signature}`));
  });

  it("is order-independent across selectors", () => {
    // #given
    const signatures = ["newUIMultiplier()", "effectiveAt()"];
    // #when
    const ids = [interfaceId(signatures), interfaceId([...signatures].reverse())];
    // #then
    assert.equal(ids[0], ids[1]);
  });
});

describe("erc8056InterfaceIds", () => {
  it("matches the IDs published in the ERC-8056 text (https://eips.ethereum.org/EIPS/eip-8056)", () => {
    // #given
    const published = {
      core: "0xa60bf13d",
      pending: "0x4bd27648",
      balances: "0xd890fd71",
      conversion: "0x57854fc3",
    };
    // #when
    const computed = erc8056InterfaceIds();
    // #then
    assert.deepEqual(computed, published);
  });
});
