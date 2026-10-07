import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeTransmission,
  encodeTransmission,
  roundInHotVars,
  transmissionSlot,
  withRound,
} from "../src/feed.ts";

// Read from the NVDA/USD aggregator's storage on mainnet at block 82077644, where latestRoundData
// returned round 1183, answer 24073646453, updated at 1791326839.
const HOT_VARS = 0x49f0001d68d0503n;
const ROUND = 1183;

describe("aggregator storage", () => {
  it("reads the latest round out of the hot vars word", () => {
    // #given
    const word = HOT_VARS;
    // #when
    const round = roundInHotVars(word);
    // #then
    assert.equal(round, ROUND);
  });

  it("changes only the latest round when it writes one", () => {
    // #given
    const word = HOT_VARS;
    // #when
    const written = withRound(word, ROUND + 1);
    // #then
    assert.equal(written ^ word, (BigInt(ROUND) ^ BigInt(ROUND + 1)) << 48n);
  });

  it("packs a transmission into the word layout it reads back", () => {
    // #given
    const transmission = {
      answer: 24_073_646_453n,
      observedAt: 1_791_575_940,
      recordedAt: 1_791_575_940,
    };
    // #when
    const decoded = decodeTransmission(encodeTransmission(transmission));
    // #then
    assert.deepEqual(decoded, transmission);
  });

  it("keeps a negative answer's sign through the int192 field", () => {
    // #given
    const transmission = { answer: -5n, observedAt: 1, recordedAt: 2 };
    // #when
    const decoded = decodeTransmission(encodeTransmission(transmission));
    // #then
    assert.equal(decoded.answer, -5n);
  });

  it("finds a round's word where a mapping at slot 17 keeps it", () => {
    // #given
    const round = ROUND;
    // #when
    const slot = transmissionSlot(round);
    // #then
    // From `cast index uint256 1183 17`.
    assert.equal(slot, "0x41dc1650a690eb7bca3daf8bdec397f9df17f69322c7660e36628ed34d83bc7c");
  });
});
