import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortKeys } from "../src/output.ts";

describe("sortKeys", () => {
  it("orders keys at every depth and leaves arrays in order", () => {
    // #given
    const value = { b: 1, a: { d: [{ z: 1, y: 2 }], c: null } };
    // #when
    const text = JSON.stringify(sortKeys(value));
    // #then
    assert.equal(text, '{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });
});
