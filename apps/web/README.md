# Web app

Two pages from one Vite build.

- `/` is the landing page. Its hero ladder is built around the latest Chainlink NVDA/USD price, read straight from the feed. Without an RPC it shows an empty ladder instead.
- `/app/` is the holder app. A holder picks a price on this week's ladder and places an order to sell NVDA at it or buy NVDA at it. The app shows what each order is doing, this week's bids, and anything ready to withdraw. It reads the chain directly. Order history comes from the indexer when one is configured.

Both pages take their colours, type, symbol, icons and token logos from [`packages/brand`](../../packages/brand). They follow the system's light or dark setting, and the theme toggle overrides it for that browser.

## Settings

Build-time variables, read by Vite from this directory's env files:

- `VITE_RPC_URL`: a Robinhood Chain RPC. Both pages use it.
- `VITE_MARKET`: the market's address.
- `VITE_INDEXER_URL`: the indexer's base URL. Optional. Without it, order history is hidden.

Until `/disclosures.json` is published, the app is read-only: it shows the ladder and orders but doesn't offer to place an order.

## Development

```sh
pnpm --filter @vayle/web test        # formats, tickets, order lines and the week, without a network
pnpm --filter @vayle/web build
pnpm --filter @vayle/web dev:fork    # against a local fork, see tools/local-fork
```
