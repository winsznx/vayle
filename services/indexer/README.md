# Indexer

A Cloudflare Worker that copies every event the market emits into Supabase and serves them back as a read-only API. The app reads balances, orders and claims straight from the chain, so nothing a holder does depends on this service. It adds history: what an order has earned, how many weeks it filled, and how many weeks in a row it hasn't.

## API

All responses are JSON, with a `source` block naming the chain, the market and the last block indexed.

- `GET /v1/owners/:address/orders`: the IDs of the orders an address placed.
- `GET /v1/orders/:id`: the order's events, plus premium earned in USDG base units, weeks filled and the current skip streak.
- `GET /v1/run?after=<block>`: every market event after a block, 500 at a time, oldest first. This is the public record of the market.

A week counts toward the skip streak once its renewal batch deadline has passed, and only if the order existed before that week's batch opened.

## Configuration

Secrets: `ROBINHOOD_RPC_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Vars, once the contracts are deployed: `VAYLE_MARKET` and `VAYLE_START_BLOCK`. The tables come from `supabase/migrations`.

## Development

```sh
pnpm --filter @vayle/indexer test
```
