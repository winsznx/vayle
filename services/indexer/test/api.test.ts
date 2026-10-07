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

  it("lists an owner's own events and their orders' events, oldest first, once each", async () => {
    // #given: the placement is filed under both the owner and the order
    const placed = stored("OrderPlaced", "5");
    const credited = { ...stored("Credited", null), block_number: 12 };
    const filled = { ...stored("BatchFilled", "5"), block_number: 11, account: null };
    const select = (filter: string): Promise<MarketEvent[]> =>
      Promise.resolve(
        filter.startsWith("account=")
          ? [placed, credited]
          : filter === "order_id=in.(5)"
            ? [placed, filled]
            : [],
      );
    // #when
    const response = await handle(new Request(`https://api.example/v1/owners/${OWNER}/events`), {
      ...deps([]),
      select,
    });
    // #then
    const payload = (await body(response)) as { events: MarketEvent[] };
    assert.deepEqual(
      payload.events.map((e) => e.name),
      ["OrderPlaced", "BatchFilled", "Credited"],
    );
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

// `count` events in one block, log indexes from 0.
function inBlock(block: number, count: number): MarketEvent[] {
  return Array.from({ length: count }, (_, logIndex) => ({
    ...stored("Credited", null),
    block_number: block,
    log_index: logIndex,
  }));
}

function positions(events: readonly MarketEvent[]): string[] {
  return events.map((e) => `${e.block_number}:${e.log_index}`);
}

// The filters /v1/run sends, applied to `rows` the way PostgREST would, in primary key order. A
// filter it doesn't know fails the test instead of matching everything. `seen` gets every filter,
// and "source" whenever the indexed tip is read.
function runDeps(rows: MarketEvent[], seen: string[] = []): ApiDeps {
  return {
    ...deps([]),
    source: () => {
      seen.push("source");
      return deps([]).source();
    },
    select: (filter) => {
      seen.push(filter);
      let matched = [...rows].sort(
        (a, b) => a.block_number - b.block_number || a.log_index - b.log_index,
      );
      let limit = matched.length;
      for (const part of filter.split("&")) {
        const [first = 0, second = 0, third = 0] = (part.match(/[0-9]+/g) ?? []).map(Number);
        switch (part.replace(/[0-9]+/g, "N")) {
          case "block_number=gt.N":
            matched = matched.filter((e) => e.block_number > first);
            break;
          case "block_number=gte.N":
            matched = matched.filter((e) => e.block_number >= first);
            break;
          case "or=(block_number.gt.N,and(block_number.eq.N,log_index.gt.N))":
            matched = matched.filter(
              (e) => e.block_number > first || (e.block_number === second && e.log_index > third),
            );
            break;
          case "limit=N":
            limit = first;
            break;
          default:
            throw new Error(`not a filter /v1/run sends: ${part}`);
        }
      }
      return Promise.resolve(matched.slice(0, limit));
    },
  };
}

interface RunPage {
  readonly events: MarketEvent[];
  readonly next: string;
}

// One page, asked for the way a browser would, with the cursor URL-encoded.
async function page(api: ApiDeps, after?: string): Promise<RunPage> {
  const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const response = await handle(new Request(`https://api.example/v1/run${query}`), api);
  assert.equal(response.status, 200);
  return (await body(response)) as RunPage;
}

describe("run", () => {
  it("picks up the rest of a block on the next page when a page ends inside it", async () => {
    // #given: 300 events in block 9 and 300 in block 10, so the first page stops at 10:199
    const api = runDeps([...inBlock(9, 300), ...inBlock(10, 300)]);
    // #when
    const first = await page(api);
    const second = await page(api, first.next);
    // #then
    assert.deepEqual(
      [first.events.length, first.next, positions(second.events).slice(0, 2), second.events.length],
      [500, "10:199", ["10:200", "10:201"], 100],
    );
  });

  it("walks a block of more than a page, every event once and in order", async () => {
    // #given
    const rows = [...inBlock(10, 1_201), ...inBlock(11, 2)];
    const api = runDeps(rows);
    // #when
    const walked: MarketEvent[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const { events, next } = await page(api, after);
      if (events.length === 0) break;
      walked.push(...events);
      after = next;
    }
    // #then
    assert.deepEqual(positions(walked), positions(rows));
  });

  it("points next at the last page's last event, so asking again later returns only newer events", async () => {
    // #given: a client that has read the last page
    const rows = inBlock(10, 3);
    const api = runDeps(rows);
    const last = await page(api, "9");
    // #when: block 12 is indexed after the last page was read
    rows.push(...inBlock(12, 1));
    const later = await page(api, last.next);
    // #then
    assert.deepEqual(
      [positions(last.events), last.next, positions(later.events), later.next],
      [["10:0", "10:1", "10:2"], "10:2", ["12:0"], "12:0"],
    );
  });

  it("answers an empty page with the cursor it was given as next", async () => {
    // #given
    const api = runDeps(inBlock(10, 3));
    // #when
    const pages = await Promise.all([
      page(api, "10:2"),
      page(api, "10"),
      page(api, "0010"),
      page(runDeps([])),
    ]);
    // #then
    assert.deepEqual(
      pages.map((p) => [p.events.length, p.next]),
      [
        [0, "10:2"],
        [0, "10"],
        [0, "10"],
        [0, "0"],
      ],
    );
  });

  it("still reads after=<block> as everything after that whole block, with the same query as before", async () => {
    // #given
    const seen: string[] = [];
    const api = runDeps([...inBlock(10, 2), ...inBlock(11, 2)], seen);
    // #when
    const result = await page(api, "10");
    // #then
    assert.deepEqual(
      [positions(result.events), result.next, seen],
      [["11:0", "11:1"], "11:1", ["source", "block_number=gt.10&limit=500"]],
    );
  });

  it("starts the store's scan at the cursor's block, after reading the indexed tip", async () => {
    // #given
    const seen: string[] = [];
    // #when
    await page(runDeps([], seen), "10:199");
    // #then
    assert.deepEqual(seen, [
      "source",
      "block_number=gte.10&or=(block_number.gt.10,and(block_number.eq.10,log_index.gt.199))&limit=500",
    ]);
  });

  it("refuses a malformed cursor with a reason, before reading anything", async () => {
    // #given
    const seen: string[] = [];
    const api = runDeps(inBlock(10, 3), seen);
    const shape = "after must be <block> or <block>:<logIndex>";
    const cases: [string, string][] = [
      ["", shape],
      ["latest", shape],
      ["-1", shape],
      ["+1", shape],
      ["1.5", shape],
      ["1e3", shape],
      ["0x10", shape],
      [" 10", shape],
      ["10:", shape],
      [":5", shape],
      ["10:5:1", shape],
      ["10:-1", shape],
      ["10;5", shape],
      ["1".repeat(79), shape],
      ["9223372036854775808", "after's block number is too large"],
      ["10:2147483648", "after's log index is too large"],
    ];
    // #when
    const answers = await Promise.all(
      cases.map(async ([after]) => {
        const response = await handle(
          new Request(`https://api.example/v1/run?after=${encodeURIComponent(after)}`),
          api,
        );
        return [response.status, ((await body(response)) as { error: string }).error];
      }),
    );
    // #then
    assert.deepEqual([answers, seen], [cases.map(([, reason]) => [400, reason]), []]);
  });

  it("takes the largest block number and log index the table can hold", async () => {
    // #when
    const pages = await Promise.all([
      page(runDeps([]), "9223372036854775807"),
      page(runDeps([]), "10:2147483647"),
    ]);
    // #then
    assert.deepEqual(
      pages.map((p) => p.next),
      ["9223372036854775807", "10:2147483647"],
    );
  });
});
