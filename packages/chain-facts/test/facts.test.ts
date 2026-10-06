import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { diffFacts } from "../src/facts.ts";
import { BEACON_SLOT, eip712DomainSeparator, IMPLEMENTATION_SLOT } from "../src/resolve.ts";

describe("diffFacts", () => {
  it("separates volatile changes from drift", () => {
    // #given
    const committed = { block: { number: "1" }, nvda: { address: "0xA", uiMultiplier: "1" } };
    const current = { block: { number: "2" }, nvda: { address: "0xB", uiMultiplier: "2" } };
    // #when
    const differences = diffFacts(committed, current);
    // #then
    assert.deepEqual(
      differences.map((d) => [d.path, d.volatile]),
      [
        ["block.number", true],
        ["nvda.address", false],
        ["nvda.uiMultiplier", true],
      ],
    );
  });

  it("reports nothing for identical facts", () => {
    // #given
    const facts = { chain: { chainId: 4663 }, erc8056: { interfaceIds: { core: "0x01" } } };
    // #when
    const differences = diffFacts(facts, structuredClone(facts));
    // #then
    assert.deepEqual(differences, []);
  });
});

describe("EIP-1967 slots", () => {
  it("match the constants published in https://eips.ethereum.org/EIPS/eip-1967", () => {
    // #given
    const published = [
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
      "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
    ];
    // #when
    const computed = [IMPLEMENTATION_SLOT, BEACON_SLOT];
    // #then
    assert.deepEqual(computed, published);
  });
});

describe("eip712DomainSeparator", () => {
  it("reproduces the USDG separator read on chain at block 81944099", () => {
    // #given
    const usdg = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    // #when
    const separator = eip712DomainSeparator("Global Dollar", "1", 4663, usdg);
    // #then
    assert.equal(separator, "0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036");
  });
});
