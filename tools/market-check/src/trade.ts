import { formatUnits, zeroAddress, type Address } from "viem";
import {
  nextSize,
  recordQuote,
  shortfallBps,
  sizeForValue,
  startSearch,
  valueAtFeed,
  withinLimit,
  type PriceUnits,
  type Search,
} from "./liquidity.ts";
import type { PoolIndex } from "./pools.ts";
import type { Handle, Read, Rpc } from "./rpc.ts";
import type { LiquidityCheck } from "./types.ts";
import { leg, otherSide, quote, type Pool, type Route, type UniswapContracts } from "./uniswap.ts";

// Selling a cap's worth of each token for USDG, priced by Uniswap's own quoters at the pinned
// block, every token's quotes for a round in the same calls.
//
//   1. Every first hop out of the token, into USDG or a hub, quoted at the cap.
//   2. For each protocol and hub, every hub pool on that protocol quoted into USDG at the largest
//      hub amount any token's best first hop returned. Every cap is the same dollar amount, so
//      those amounts are close, and the hub pool that pays most for the largest is taken for all.
//   3. Each token's best first hop into each hub, followed by that hub pool, quoted whole by the
//      protocol's quoter at the cap.
//   4. For each route that sells the cap within the limit, the largest size it sells within the
//      limit, by bisection over at most MAX_QUOTES quotes, every route's next quote in the same
//      round. The route paying most for a small sale can be a shallow pool with a low fee, so the
//      token's route is the one that sells the most. With no route within the limit at the cap,
//      it's the route paying most at the cap, and its bisection runs below the cap.

// Quotes through deep pools cost under 300,000 gas, so 16 to a call is about 5M. One through a
// thin pool can cost tens of millions and starve the rest of the call, so a quote that reverts
// without data inside a shared call is tried again alone.
const QUOTES_PER_CALL = 16;
// Routes within the limit at the cap that get a bisection, the best paying first.
const MAX_SEARCHED_ROUTES = 6;

export interface Sale {
  readonly token: Address;
  readonly symbol: string;
  readonly price: PriceUnits;
}

export interface TradeSetup {
  readonly contracts: UniswapContracts;
  readonly pools: PoolIndex;
  readonly usdg: Address;
  // Hubs for one-hop routes besides any the pool sample turned up: native ETH and WETH.
  readonly hubs: readonly Address[];
  readonly capUsdBase: bigint;
  readonly maxSlippageBps: number;
  readonly names: ReadonlyMap<Address, string>;
}

interface Quoted {
  readonly route: Route;
  readonly handle: Handle<bigint>;
}

interface Priced {
  readonly route: Route;
  readonly out: bigint;
}

interface RouteSearch {
  readonly priced: Priced;
  search: Search;
  pending: { readonly size: bigint; readonly handle: Handle<bigint> } | null;
}

interface SaleState {
  readonly sale: Sale;
  readonly cap: bigint;
  readonly value: bigint;
  readonly first: readonly Quoted[];
  whole: Quoted[];
  searches: RouteSearch[];
  chosen: RouteSearch | null;
  readonly errors: string[];
}

function outOf(read: Read<bigint>): bigint | null {
  return read.ok && read.value > 0n ? read.value : null;
}

function hubKey(route: Route): string {
  return `${route.protocol}:${route.path[1] ?? ""}`;
}

function routeName(route: Route, names: ReadonlyMap<Address, string>): string {
  const symbols = route.path.map((a) => (a === zeroAddress ? "ETH" : (names.get(a) ?? a)));
  return `${route.protocol} ${symbols.join(" > ")}`;
}

function batch(rpc: Rpc): ReturnType<Rpc["batch"]> {
  return rpc.batch({ perCall: QUOTES_PER_CALL, retryEmptyReverts: true });
}

export function emptyLiquidity(status: "fail" | "not_run", reason: string): LiquidityCheck {
  return {
    status,
    reason,
    venue: null,
    route: null,
    pools: null,
    capSizeRaw: null,
    usdgOut: null,
    slippageBps: null,
    maxSizeWithinLimitRaw: null,
  };
}

// The hubs a token can route through: the setup's, plus any currency a sampled pool pairs it with
// that also has a pool with USDG.
function hubsFor(token: Address, setup: TradeSetup): Address[] {
  const hubs = new Set<Address>(setup.hubs);
  for (const pool of setup.pools.involving(token)) {
    const other = otherSide(pool, token);
    if (
      other !== null &&
      other !== setup.usdg &&
      setup.pools.between(other, setup.usdg).length > 0
    ) {
      hubs.add(other);
    }
  }
  return [...hubs];
}

export async function checkLiquidity(
  rpc: Rpc,
  setup: TradeSetup,
  sales: readonly Sale[],
): Promise<Map<Address, LiquidityCheck>> {
  const results = new Map<Address, LiquidityCheck>();
  const states: SaleState[] = [];

  // 1. Every first hop at the cap.
  const firstHops = batch(rpc);
  for (const sale of sales) {
    const cap = sizeForValue(setup.capUsdBase, sale.price);
    const value = valueAtFeed(cap, sale.price);
    if (cap === 0n || value === 0n) {
      results.set(
        sale.token,
        emptyLiquidity("not_run", "the cap is worth less than one base unit"),
      );
      continue;
    }
    const hubs = hubsFor(sale.token, setup);
    const first: Quoted[] = [];
    for (const to of [setup.usdg, ...hubs]) {
      for (const pool of setup.pools.between(sale.token, to)) {
        const route: Route = { protocol: pool.protocol, path: [sale.token, to], pools: [pool] };
        first.push({ route, handle: firstHops.add(quote(setup.contracts, route, cap)) });
      }
    }
    if (first.length === 0) {
      const via = hubs.map((h) => (h === zeroAddress ? "ETH" : (setup.names.get(h) ?? h)));
      const reason = `no Uniswap v2, v3 or v4 pool with liquidity pairs ${sale.symbol} with USDG, directly or through ${via.join(", ")}`;
      results.set(sale.token, emptyLiquidity("fail", reason));
      continue;
    }
    states.push({ sale, cap, value, first, whole: [], searches: [], chosen: null, errors: [] });
  }
  await firstHops.run();

  // Each token's best first hop into each hub, and the largest of those amounts per hub.
  const bestInto = new Map<SaleState, Map<string, Priced>>();
  const largest = new Map<string, { hub: Address; protocol: Route["protocol"]; amount: bigint }>();
  for (const s of states) {
    const mine = new Map<string, Priced>();
    for (const q of s.first) {
      const read = q.handle.read();
      if (!read.ok) s.errors.push(`${routeName(q.route, setup.names)}: ${read.error}`);
      const out = outOf(read);
      const hub = q.route.path[1];
      if (out === null || hub === undefined || hub === setup.usdg) continue;
      const key = hubKey(q.route);
      const current = mine.get(key);
      if (current === undefined || out > current.out) mine.set(key, { route: q.route, out });
      const top = largest.get(key);
      if (top === undefined || out > top.amount) {
        largest.set(key, { hub, protocol: q.route.protocol, amount: out });
      }
    }
    bestInto.set(s, mine);
  }

  // 2. Every hub pool into USDG at the largest hub amount, per protocol and hub.
  const hubLegs = batch(rpc);
  const hubQuotes = new Map<string, { pool: Pool; handle: Handle<bigint> }[]>();
  for (const [key, { hub, protocol, amount }] of largest) {
    const quotes = setup.pools
      .between(hub, setup.usdg)
      .filter((pool) => pool.protocol === protocol)
      .map((pool) => {
        const route: Route = { protocol, path: [hub, setup.usdg], pools: [pool] };
        return { pool, handle: hubLegs.add(quote(setup.contracts, route, amount)) };
      });
    hubQuotes.set(key, quotes);
  }
  await hubLegs.run();
  const hubPool = new Map<string, Pool>();
  for (const [key, quotes] of hubQuotes) {
    let top: { pool: Pool; out: bigint } | null = null;
    for (const { pool, handle } of quotes) {
      const out = outOf(handle.read());
      if (out !== null && (top === null || out > top.out)) top = { pool, out };
    }
    if (top !== null) hubPool.set(key, top.pool);
  }

  // 3. Each two-hop route whole, at the cap.
  const wholeRoutes = batch(rpc);
  for (const s of states) {
    for (const [key, { route }] of bestInto.get(s) ?? []) {
      const second = hubPool.get(key);
      const [firstPool] = route.pools;
      const hub = route.path[1];
      if (second === undefined || firstPool === undefined || hub === undefined) continue;
      const whole: Route = {
        protocol: route.protocol,
        path: [s.sale.token, hub, setup.usdg],
        pools: [firstPool, second],
      };
      s.whole.push({ route: whole, handle: wholeRoutes.add(quote(setup.contracts, whole, s.cap)) });
    }
  }
  await wholeRoutes.run();

  // 4. A bisection on each route within the limit at the cap, or on the best paying route when
  // none is, every search's next quote in the same round.
  for (const s of states) {
    const priced: Priced[] = [];
    for (const q of [...s.first.filter((f) => f.route.path[1] === setup.usdg), ...s.whole]) {
      const read = q.handle.read();
      if (!read.ok && q.route.pools.length > 1) {
        s.errors.push(`${routeName(q.route, setup.names)}: ${read.error}`);
      }
      const out = outOf(read);
      if (out !== null) priced.push({ route: q.route, out });
    }
    priced.sort((a, b) => (a.out > b.out ? -1 : a.out < b.out ? 1 : 0));
    const within = priced.filter((p) => withinLimit(p.out, s.value, setup.maxSlippageBps));
    const searched = within.length > 0 ? within.slice(0, MAX_SEARCHED_ROUTES) : priced.slice(0, 1);
    s.searches = searched.map((p) => ({
      priced: p,
      search: startSearch(s.cap, within.length > 0),
      pending: null,
    }));
  }
  for (;;) {
    const round = batch(rpc);
    for (const s of states) {
      for (const r of s.searches) {
        const size = nextSize(r.search);
        r.pending =
          size === null
            ? null
            : { size, handle: round.add(quote(setup.contracts, r.priced.route, size)) };
      }
    }
    if (round.size === 0) break;
    await round.run();
    for (const s of states) {
      for (const r of s.searches) {
        if (r.pending === null) continue;
        const out = outOf(r.pending.handle.read());
        const value = valueAtFeed(r.pending.size, s.sale.price);
        const within = out !== null && withinLimit(out, value, setup.maxSlippageBps);
        r.search = recordQuote(r.search, r.pending.size, within);
        r.pending = null;
      }
    }
  }
  // The token's route sells the most within the limit, and pays the most at the cap among those.
  for (const s of states) {
    for (const r of s.searches) {
      const size = r.search.within ?? 0n;
      const top = s.chosen?.search.within ?? -1n;
      if (s.chosen === null || size > top || (size === top && r.priced.out > s.chosen.priced.out)) {
        s.chosen = r;
      }
    }
  }

  for (const s of states) results.set(s.sale.token, judged(s, setup));
  return results;
}

function judged(s: SaleState, setup: TradeSetup): LiquidityCheck {
  if (s.chosen === null) {
    const first = s.errors[0];
    return emptyLiquidity(
      "fail",
      `every quote for ${s.sale.symbol} failed${first === undefined ? "" : `, the first with ${first}`}`,
    );
  }
  const { route, out } = s.chosen.priced;
  const bps = shortfallBps(out, s.value);
  const within = withinLimit(out, s.value, setup.maxSlippageBps);
  const usdg = (amount: bigint): string => formatUnits(amount, s.sale.price.usdgDecimals);
  const size = formatUnits(s.cap, s.sale.price.tokenDecimals);
  return {
    status: within ? "pass" : "fail",
    reason: within
      ? ""
      : `the best paying route, ${routeName(route, setup.names)}, pays ${usdg(out)} USDG for ${size} ${s.sale.symbol} worth ${usdg(s.value)} at the feed's price, ${bps} bps short`,
    venue: route.protocol,
    route: [...route.path],
    pools: route.pools.map(leg),
    capSizeRaw: s.cap.toString(),
    usdgOut: out.toString(),
    slippageBps: bps,
    maxSizeWithinLimitRaw: (s.chosen.search.within ?? 0n).toString(),
  };
}
