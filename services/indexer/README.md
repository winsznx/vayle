# Indexer

A Cloudflare Worker that copies every event the market emits into Supabase and serves them back as a read-only API. The app reads balances, orders and claims straight from the chain, so nothing a holder does depends on this service. It adds history: what an order has earned, how many weeks it filled, and how many weeks in a row it hasn't.

On mainnet the indexing passes run on a server, from [infra/server](../../infra/server), where the chain's public RPC answers, and the Worker has no cron and only serves the API.

## API

All responses are JSON, with a `source` block naming the chain, the market and the last block indexed.

- `GET /v1/owners/:address/orders`: the IDs of the orders an address placed.
- `GET /v1/owners/:address/events`: everything filed under the address (placements, credits, withdrawals) and every event of the orders it placed, oldest first.
- `GET /v1/orders/:id`: the order's events, plus premium earned in USDG base units, weeks filled and the current skip streak.
- `GET /v1/run?after=<cursor>`: every market event after a cursor, 500 at a time, oldest first, with a `next` cursor for the page after. This is the public record of the market.

For the skip streak, a week counts once its batch can no longer fill, 3 days after it opens or an hour past its batch deadline when that's later, for an order placed before that week's batch could open, 4 hours after the close, or one that filled that week (`weekSettlesAt` and `BATCH_OPENS_AFTER` in `packages/market/src/history.ts`). The streak is the run of counted weeks, newest first, without a fill, and only active orders have one.

To read the whole record, start without `after` and pass each response's `next` back as `after`, unchanged. A cursor is `<block>:<logIndex>`, the position of the last event you have, and the next page starts right after it, so a page that ends partway through a block carries on with the rest of that block. The old form, a plain `<block>`, still works and means everything after that whole block. A page with fewer than 500 events means you've caught up, and you have every event through `source.toBlock`. Ask again later with the same `next` for newer ones. An empty page returns the cursor you sent as `next`. A cursor in any other form, or with a number too large for a block or a log index, gets a 400 with the reason.

## Configuration

Secrets: `ROBINHOOD_RPC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Vars, once the contracts are deployed: `VAYLE_MARKET` and `VAYLE_START_BLOCK`. The tables come from `supabase/migrations`.

A pass reads the market's logs 10,000 blocks per request, at most four requests a pass, and takes each block's time from the `blockTimestamp` on its logs. So `ROBINHOOD_RPC_URL` has to serve eth_getLogs over 10,000 blocks. An RPC that leaves the timestamp off still works, at the cost of one block lookup for each block with events.

The client is built on `robinhoodChain` from `@vayle/chain-facts/chain`, the same chain the other services use. The indexer makes no eth_call, so there's nothing for Multicall3 to batch: a pass is the latest block number and one eth_getLogs per 10,000 blocks, a handful of RPC requests. Errors are logged without the RPC's URL, through `errorText` and `redacted` from `@vayle/chain-facts/rpc-errors`, and a refused range carries only the RPC's own words.

The app's `VITE_INDEXER_URL` is the base URL the API answers on: the Worker's URL, or the server's address behind its proxy.

## Running on a server

The same code runs as a long-running Node process instead of a Worker: an indexing pass every minute, never two at once, and the API on `PORT` (8787 by default). It needs Node 24 and the repo checked out with `pnpm install`.

```sh
node --env-file=.env services/indexer/src/node.ts
```

The `.env` holds the same settings as the Worker. Under a service manager, run that command from the repo root and have it restart the process when it exits, and put the API behind a reverse proxy with TLS. A pass that fails, for example while the database is unreachable, is logged and retried on the next one. The exception is an RPC that refuses the log range as too wide. Every pass would get the same answer, so the process stops indexing with `LogRangeRefused` and keeps serving the API. The Worker fails each run with that error until the range or the RPC changes.

## Development

```sh
pnpm --filter @vayle/indexer test
```
