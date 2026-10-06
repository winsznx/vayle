# Watcher

A Cloudflare Worker that checks the chain every minute and posts an alert when something needs a person: an issuer pauses NVDA, USDG or the NVDA oracle, a corporate action is pending, the NVDA feed goes quiet in the trading week, the keeper goes silent near a close, a week's epoch hasn't opened, the session calendar is running out, or anyone uses an owner or guardian power. It never sends transactions.

Each alert goes out once when a condition starts, hourly while a paging condition lasts, and once when it clears. Contract events alert once each. Delivery is at least once: if posting fails, the next run retries.

## Configuration

Secrets, set with `wrangler secret put`:

- `ROBINHOOD_RPC_URL`: a Robinhood Chain mainnet RPC with archive access.
- `WATCHER_WEBHOOK_URL`: where alerts are posted, as Slack-compatible JSON.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: the project holding the `watcher_state` table from `supabase/migrations`.

Vars, set once the contracts are deployed, all together or not at all: `VAYLE_MARKET`, `VAYLE_LIVENESS`, `VAYLE_CALENDAR`, `VAYLE_REGISTRY` and `VAYLE_START_BLOCK`. Without them the watcher covers NVDA, USDG and the feed only.

## Development

```sh
pnpm --filter @vayle/watcher test
```

The rules are pure functions of a chain snapshot and decoded logs, so the tests need no network.
