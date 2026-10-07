# Indexer

A Cloudflare Worker that copies every event the market emits into Supabase and serves them back as a read-only API. The app reads balances, orders and claims straight from the chain, so nothing a holder does depends on this service. It adds history: what an order has earned, how many weeks it filled, and how many weeks in a row it hasn't.

## API

All responses are JSON, with a `source` block naming the chain, the market and the last block indexed.

- `GET /v1/owners/:address/orders`: the IDs of the orders an address placed.
- `GET /v1/owners/:address/events`: everything filed under the address (placements, credits, withdrawals) and every event of the orders it placed, oldest first.
- `GET /v1/orders/:id`: the order's events, plus premium earned in USDG base units, weeks filled and the current skip streak.
- `GET /v1/run?after=<block>`: every market event after a block, 500 at a time, oldest first. This is the public record of the market.

A week counts toward the skip streak once its renewal batch deadline has passed, and only if the order existed before that week's batch opened.

## Configuration

Secrets: `ROBINHOOD_RPC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Vars, once the contracts are deployed: `VAYLE_MARKET` and `VAYLE_START_BLOCK`. The tables come from `supabase/migrations`.

## Running on a server

The same code runs as a long-running Node process instead of a Worker: an indexing pass every minute, never two at once, and the API on `PORT` (8787 by default). It needs Node 24 and the repo checked out with `pnpm install`.

```sh
node --env-file=.env services/indexer/src/node.ts
```

The `.env` holds the same settings as the Worker. Under systemd, run that command from the repo root with `Restart=always`, and put the API behind a reverse proxy with TLS. A pass that fails, for example while the database is unreachable, is logged and retried on the next one.

## Development

```sh
pnpm --filter @vayle/indexer test
```
