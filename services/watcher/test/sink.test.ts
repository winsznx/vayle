import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alertPayload } from "../src/sink.ts";

describe("alertPayload", () => {
  it("puts pages first and labels each line", () => {
    // #given
    const alerts = [
      { key: "a", severity: "info" as const, text: "listed" },
      { key: "b", severity: "page" as const, text: "halted" },
      { key: "c", severity: "warn" as const, text: "runway" },
    ];
    // #when
    const payload = alertPayload(alerts);
    // #then
    assert.equal(payload.text, "[PAGE] halted\n[WARN] runway\n[info] listed");
  });
});
