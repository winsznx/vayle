import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StoreRowMalformed } from "../src/errors.ts";
import { EMPTY_STATE, parseRows, saveRequest } from "../src/store.ts";

const store = { url: "https://project.supabase.example", serviceKey: "service-key" };

describe("parseRows", () => {
  it("starts empty before the first run", () => {
    // #when
    const state = parseRows([]);
    // #then
    assert.deepEqual(state, EMPTY_STATE);
  });

  it("reads the cursor, active conditions and failure count", () => {
    // #given
    const rows = [
      {
        cursor_block: "82000000",
        active: { "halt-active": { severity: "page", since: 1, lastSent: 2 } },
        failures: 0,
      },
    ];
    // #when
    const state = parseRows(rows);
    // #then
    assert.deepEqual(state, {
      cursor: 82_000_000n,
      active: { "halt-active": { severity: "page", since: 1, lastSent: 2 } },
      failures: 0,
    });
  });

  it("refuses a malformed row instead of starting over", () => {
    // #given
    const rows = [{ cursor_block: "1", active: { x: { severity: "loud" } }, failures: 0 }];
    // #when
    const parse = (): unknown => parseRows(rows);
    // #then
    assert.throws(parse, StoreRowMalformed);
  });
});

describe("saveRequest", () => {
  it("upserts the single state row with the service key", () => {
    // #when
    const { url, init } = saveRequest(store, { cursor: 5n, active: {}, failures: 1 });
    // #then
    const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
    assert.deepEqual(
      [url, init.method, body],
      [
        "https://project.supabase.example/rest/v1/watcher_state?on_conflict=id",
        "POST",
        { id: "main", cursor_block: "5", active: {}, failures: 1 },
      ],
    );
  });
});
