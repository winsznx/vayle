# Keeper

A Cloudflare Worker that runs Vayle's weekly schedule every minute. Every call it makes is one anyone could make. Its key holds gas only, and if it stops, nothing is lost: windows extend through liveness gaps, and anyone can finalize, settle or finish a renewal batch.

Each run reads the chain, plans what's due and sends it:

- Liveness pings from 45 minutes before each close, oracle observations in the last 30 minutes, and pings with issuer pause observations through each exercise window.
- Creating the week's epoch after the close, with the feed's last round at or before it.
- Finalizing each series once its window has ended, then settling every order attached to it.
- Running each renewal batch once the bid window has passed: open, count every idle order in the bucket, fill, in chunks of 100 orders.

## Configuration

Secrets, set with `wrangler secret put`: `ROBINHOOD_RPC_URL` and `KEEPER_KEY`. Vars, set once the contracts are deployed: `VAYLE_MARKET`, `VAYLE_LIVENESS` and `VAYLE_CALENDAR`.

## Development

```sh
pnpm --filter @vayle/keeper test         # the planner, without a network
pnpm --filter @vayle/keeper test:chain   # the round search against the real NVDA feed; needs ROBINHOOD_RPC_URL
```
