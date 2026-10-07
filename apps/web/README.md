# Web app

The site at vayle.xyz: the landing page at `/` and the holder app under `/app/`, built with Vite and React and served by a Cloudflare Worker, with the build as its static assets.

## Pages

| Route             | What it shows                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | The landing: what an order does and how a week runs, around a ladder built from NVDA's latest Chainlink price                                                                                                                                        |
| `/app/`           | The overview: NVDA's last month of feed rounds with this week's close and your order prices marked, your holdings at the feed's price, the week's stages, what needs you, your orders, recent activity, and this week's prices with the maker's bids |
| `/app/trade`      | This week's ladder and the order ticket                                                                                                                                                                                                              |
| `/app/orders`     | Your orders by state                                                                                                                                                                                                                                 |
| `/app/orders/:id` | One order: its terms, what it has earned, its history, and the form that changes its price, amount or least premium                                                                                                                                  |
| `/app/activity`   | Everything that happened to your orders and your wallet in the market                                                                                                                                                                                |
| `/app/market`     | The market as the contracts report it: the week, the feed, the limits, what can stop it, the calendar and every contract address                                                                                                                     |

A build that names no market, as the site does before the contracts are deployed, shows a page at `/app/` that says Vayle isn't open yet.

Both pages take their colours, type, symbol, icons and token logos from [`packages/brand`](../../packages/brand). They follow the system's light or dark setting, and the theme toggle overrides it for that browser.

## Wallets

One Connect wallet button in the top bar opens the wallet modal. Wallets installed in the browser announce themselves and list by name. WalletConnect, for phones and wallets that live on one, joins the list when the build has a project ID. A wallet on another chain gets a button that switches it to Robinhood Chain, adding the chain with its public RPC if the wallet doesn't know it.

Every transaction estimates its gas first and sends with a margin over it, then waits for the receipt. A toast says where it is and links to the explorer, and a refusal reads as a sentence: a declined signature, too little ETH for gas, or the market's own reason, like an order that's in this week's batch.

## Reading the chain

The app reads the market every 15 seconds while the page is in view, and again after each transaction. Every read in a poll is pinned to the block the poll starts from, so a page never mixes two blocks' state, and reads that don't wait on each other leave as one Multicall3 call. A poll is one block read and two or three calls. The price chart reads the feed's last month of rounds in one call every five minutes.

In production the page reads through `/rpc` on its own origin. The Worker ([`worker/rpc.ts`](worker/rpc.ts)) forwards each request to the private RPC held as its `RPC_URL` secret, so the key never ships in the page's JavaScript. It takes read methods only, from the site's own pages only, log queries only for the addresses in `RPC_LOG_ADDRESSES` and over at most 10,000 blocks, and batches of at most 10. Each visitor's requests go through a rate limiter, so one page can't use up the plan.

History, meaning earnings, skipped weeks and activity, comes from the [indexer](../../services/indexer) when the build names one. Without it, the app reads the market's events from its deploy block, which suits a short history like the local fork's. The browser won't read more than 500,000 blocks of history itself and says the indexer is needed instead.

## Who can place an order

New orders need all of these, and the ticket says which one is missing:

- The build sets `VITE_PLACEMENT=open`, and `/disclosures.json` is published.
- The visitor isn't somewhere new orders aren't offered. The Worker checks Cloudflare's country and region for each request against `RESTRICTED_COUNTRIES` and `RESTRICTED_REGIONS` in [`wrangler.jsonc`](wrangler.jsonc) and marks the page.
- The market isn't halted or paused, and the order fits under its caps, counted the way the market counts them.
- The wallet is connected and on Robinhood Chain.

Settling, stopping an order, cancelling and withdrawing don't depend on any of these, except a halt, which stops everything until it ends. A halt or a pause is said above every page while it lasts.

## Link previews

Each page has its own title, description and 1200 by 630 card. The Worker writes them into the HTML, because a crawler that asks for `/app/orders` reads the HTML and never runs the app. Every build renders the cards from [`packages/brand/social/cards.ts`](../../packages/brand/social/cards.ts) into `og/`.

## Settings

At build time, from this directory's env files or the environment:

- `VITE_RPC_URL`: where the page reads the chain. `/rpc` in production and in dev, where the dev server forwards it to `ROBINHOOD_RPC_URL` from the repo's `.env`.
- `VITE_MARKET`: the market's address. Without it, `/app/` says Vayle isn't open yet.
- `VITE_MARKET_DEPLOY_BLOCK`: the block the market was deployed at, for reading history from the chain when there's no indexer.
- `VITE_INDEXER_URL`: the indexer's base URL. Optional.
- `VITE_PLACEMENT`: `open` for a build that takes new orders. Anything else, or nothing, leaves placement off.
- `VITE_WALLETCONNECT_PROJECT_ID`: turns on WalletConnect. Optional, since browser wallets work without it.

On the Worker:

- `RPC_URL`, a secret set with `wrangler secret put RPC_URL`: the private RPC `/rpc` forwards to.
- `RPC_LOG_ADDRESSES`: the addresses `/rpc` answers log queries for, comma-separated.
- `RESTRICTED_COUNTRIES` and `RESTRICTED_REGIONS`: where new orders aren't offered.
- `RPC_LIMITER`: the rate limit binding, set in `wrangler.jsonc`.

## Development

```sh
pnpm --filter @vayle/web dev:fork   # against the local fork, see tools/local-fork
pnpm --filter @vayle/web test       # formats, tickets, edits, caps, order lines, the week and the geofence
pnpm --filter @vayle/web build
pnpm --filter @vayle/web exec wrangler dev   # the build under the Worker, with secrets from .dev.vars
```

## Deploying

```sh
VITE_RPC_URL=/rpc VITE_MARKET=<market address> pnpm --filter @vayle/web build
pnpm --filter @vayle/web exec wrangler deploy
pnpm --filter @vayle/web exec wrangler secret put RPC_URL
```

The Worker takes `vayle.xyz` as its custom domain. [DEPLOY.md](../../DEPLOY.md) has the whole runbook.
