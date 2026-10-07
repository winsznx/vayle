import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handle, type ApiDeps } from "../src/api.ts";
import type { MarketEvent } from "@vayle/market";

const OWNER = "0x00000000000000000000000000000000000000bb";

function stored(name: string, order: string | null): MarketEvent {
  return {
    block_number: 10,
    log_index: 0,
    tx_hash: "0x01",
    block_time: "2026-10-02T20:00:00.000Z",
    name,
    order_id: order,
    series: null,
    account: OWNER,
    args: {},
  };
}

function deps(rows: readonly MarketEvent[], seen: string[] = []): ApiDeps {
  return {
    select: (filter) => {
      seen.push(filter);
      return Promise.resolve(
        rows.filter((r) => filter.includes(r.name) || filter.startsWith("or=")),
      );
    },
    source: () =>
      Promise.resolve({
        chainId: 4663,
        market: "0x00000000000000000000000000000000000000aa",
        toBlock: "10",
      }),
    now: () => 1_791_000_000,
  };
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

describe("api", () => {
  it("lists an owner's orders with where the data comes from", async () => {
    // #when
    const response = await handle(
      new Request(`https://api.example/v1/owners/${OWNER}/orders`),
      deps([stored("OrderPlaced", "5")]),
    );
    // #then
    assert.deepEqual(await body(response), {
      orders: ["5"],
      source: {
        chainId: 4663,
        market: "0x00000000000000000000000000000000000000aa",
        toBlock: "10",
      },
    });
  });

  it("refuses an owner that isn't an address", async () => {
    // #when
    const response = await handle(
      new Request("https://api.example/v1/owners/bob/orders"),
      deps([]),
    );
    // #then
    assert.equal(response.status, 400);
  });

  it("summarizes an order from its events", async () => {
    // #when
    const response = await handle(
      new Request("https://api.example/v1/orders/5"),
      deps([stored("OrderPlaced", "5")]),
    );
    // #then
    const payload = (await body(response)) as { order: { id: string; state: string } };
    assert.deepEqual([payload.order.id, payload.order.state], ["5", "active"]);
  });

  it("refuses an order ID that isn't a number before querying", async () => {
    // #given
    const seen: string[] = [];
    // #when
    const response = await handle(
      new Request("https://api.example/v1/orders/5),or=(name.eq.x"),
      deps([], seen),
    );
    // #then
    assert.deepEqual([response.status, seen], [400, []]);
  });

  it("is read-only", async () => {
    // #when
    const response = await handle(
      new Request("https://api.example/v1/run", { method: "POST" }),
      deps([]),
    );
    // #then
    assert.equal(response.status, 405);
  });
});
