# Web app

The site at vayle.xyz: the landing page at `/` and the holder app under `/app/`, built with Vite and React and served by a Cloudflare Worker, with the build as its static assets.

## What it sells, and what it is underneath

Holders see weekly targets. A Stock Token holder sets a sell target: the price they'd sell at. A USDG holder sets a buy target: the price they'd buy at. Each week a buyer pays them for the right to trade at that price when the market closes, and the target renews until it fills or they stop it.

Underneath, every target is a fully collateralized, physically settled weekly option on the market contract. A sell target is a covered call written against the holder's locked Stock Tokens, and a buy target is a cash-secured put written against their locked USDG. The payment is the option's premium. When the week closes past the target and the buyer exercises, the actual token changes hands at the strike, with nothing settled in cash against a price feed. Code, the ABI and the contracts keep the option terms (`minPremium`, `premiumValue`, `CALL`, `PUT`); anything a holder reads says sell target, buy target and payment.

## Pages

| Route             | What it shows                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | The landing: what a target does and how a week runs, around a ladder built from the first listed market's latest Chainlink price, and the owner's signed-off risk lines                                                                           |
| `/app/`           | The overview: one market's last month of feed rounds with its reference and your target prices marked, your holdings on every market at each feed's price, the week's stages, what needs you, your targets, recent activity, and the week's rates |
| `/app/trade`      | The rate sheet for one market, with its asset switcher, and the ticket that sets a target                                                                                                                                                         |
| `/app/markets`    | Every market: the live ones with their week, reference price and rates, then every other Stock Token in the market check with what it found                                                                                                       |
| `/app/orders`     | Your targets by state, each with its market's ticker                                                                                                                                                                                              |
| `/app/orders/:id` | One target: its terms, what it has earned, its history, and the form that changes its price, amount or least payment                                                                                                                              |
| `/app/activity`   | Everything that happened to your targets and your wallet in the market, each with its market's ticker                                                                                                                                             |
| `/app/market`     | Status: one market as the contracts report it, its week, feed, limits, what can stop it, the calendar and every contract address                                                                                                                  |

A build that names no market contract shows a page at `/app/` that says Vayle isn't open yet. `pnpm --filter @vayle/web build:mainnet` builds the site as vayle.xyz serves it: the market from `deployments/vayle-robinhood-mainnet.json`, `/rpc`, the maker's bid sheet and placement open.

Both pages take their colours, type, symbol and icons from [`packages/brand`](../../packages/brand). Every asset shows its real logo from the brand package's pinned files, served at `/logos/`: a Stock Token the mark of the company or fund it tracks, USDG its own. They follow the system's light or dark setting, and the theme toggle overrides it for that browser.

## Markets

The app lists every market in `markets` from [`@vayle/markets`](../../packages/markets), the parsed and checked [`deployments/markets.json`](../../deployments/markets.json). Each market brings its token, decimals, feed, lot, price tick, strike step and range, so nothing in `src` is tied to one Stock Token.

A page shows one market at a time: the first listed, or the one the URL names with `?asset=<ticker>` in any case, so `/app/trade?asset=NVDA` opens that market's rate sheet. The switcher on the rate sheet, the price card and the status page changes it, and the nav keeps it while you move between pages. Targets and activity cover every market, each row with its market's ticker badge. A target on a market the build no longer lists still shows, by its token's address, and can still be settled, stopped and withdrawn.

`/app/markets` adds every other Stock Token from [`deployments/market-check.json`](../../deployments/market-check.json), with how many checks it passed, each check it didn't, and the words "Not listed yet". It never shows a rate for one. The file is built in when it exists, as its own chunk that loads only on that page, and a build without it says the market check isn't published yet. Under the rate sheet, the app lists the live markets' tickers and says more Stock Tokens list as they pass the market check.

## The week

Each market's week comes from its latest epoch. A regular week opens at a close: the bid window opens once last week's exercise window has run, the batch writes every target at a price at one clearing bid, and the rest of the week fills by quote until the next close.

The first week a market opens after its deploy has no renewal batch. The contract records it with its batch deadline at its opening, so bids and batches are refused all week and nothing freezes. The app reads that as one stretch of fills by quote from the opening to the close, then the exercise window: the week track, the status page, the overview, the ticket and every target's line say so, with no bid window, batch or freeze. Its reference price is labeled as taken at the opening rather than a close. The logic is in [`src/app/week.ts`](src/app/week.ts).

Every time a holder reads is US Eastern, from `easternWallClock` in [`@vayle/calendar`](../../packages/calendar), and labeled ET.

## Rates

A rate is what a target is paid for the week, in USDG per whole token. It comes from two places:

- The batch's best bids, which the chain records for each of the week's series while the bid window runs.
- The maker's bid sheet, its current bid per target for fills by quote, when the build sets `VITE_MAKER_URL`.

Without a bid sheet, the batch's best bids are the rates all week. With one, batch bids show while the bid window runs, and the maker's current bids show the rest of the week, labeled with the time the maker computed them. A sell target always shows on the rate sheet. A buy target shows on the rate sheet, in the ticket and in the form that changes a target only where there's a bid for it, from the bid sheet or the batch. The rules are in [`src/app/rates.ts`](src/app/rates.ts).

The app reads `GET {VITE_MAKER_URL}/v1/bids` every 60 seconds while the page is in view. The maker has to allow the site's origin with CORS. The sheet's shape, with integers as decimal strings:

```text
{ computedAt,                                   seconds
  source: { chainId, market, block },
  markets: [ { symbol, token, expiry, round: { id, updatedAt }, volBps,
               sell: [ { target, premium, maxAmount } ],
               buy:  [ { target, premium, maxAmount } ] } ] }
```

That's the shape the maker serves, as [`services/maker/README.md`](../../services/maker/README.md) describes it.

It's read defensively ([`src/app/bidSheet.ts`](src/app/bidSheet.ts)): a sheet whose `chainId` or `market` isn't this build's is ignored whole, a market entry or a bid that doesn't parse is left out, a bid that pays nothing or covers nothing is dropped, and a market's bids count only for the week whose expiry they name. A failed request keeps the last sheet, whose computed time still shows.

## Reading the chain

The app reads every market every 15 seconds while the page is in view, and again after each transaction. Every read in a poll is pinned to the block the poll starts from, so a page never mixes two blocks' state, and reads that don't wait on each other leave as one Multicall3 call. Every market's reads start in the same groups, so a poll is one block read and three Multicall3 calls whether the build lists one market or three, plus one more call for the series of a wallet's targets, and a simulated finalize for a series whose window the chain says has run. The price chart reads the shown market's last month of feed rounds in one call every five minutes.

In production the page reads through `/rpc` on its own origin. The Worker ([`worker/rpc.ts`](worker/rpc.ts)) forwards each request to the RPC held as its `RPC_URL` secret, the chain's public RPC in production, so no key ships in the page's JavaScript. The public RPC refuses some requests from Cloudflare's shared addresses as too many, and those go to `RPC_FALLBACK_URL`, a metered RPC, instead. It takes read methods only, from the site's own pages only, log queries only for the addresses in `RPC_LOG_ADDRESSES` and over at most 10,000 blocks, and batches of at most 10. Each visitor's requests go through a rate limiter, so one page can't use up the plan.

History, meaning earnings, skipped weeks and activity, comes from the [indexer](../../services/indexer) when the build names one. Without it, the app reads the market's events from its deploy block, which suits a short history like the local fork's, and counts each target's skipped weeks on its own market's weeks. The browser won't read more than 500,000 blocks of history itself and says the indexer is needed instead.

## Disclosures

The owner's risk lines are [`disclosures.signed-off.json`](disclosures.signed-off.json): nine plain lines, in order. The landing's Risks section shows them from that file, and nothing else on either page states a risk. The app shows the disclosures it finds at `/disclosures.json`, beside the rate sheet, and reads either plain lines or items with a title and a body.

The build doesn't publish `/disclosures.json`. Publishing it, by copying the signed-off file to `public/disclosures.json`, is one of the two switches that open new targets, so it waits for the owner.

## Who can set a target

New targets need all of these, and the ticket says which one is missing:

- The build sets `VITE_PLACEMENT=open`, and `/disclosures.json` is published.
- The visitor isn't somewhere new targets aren't offered. The Worker checks Cloudflare's country and region for each request against `RESTRICTED_COUNTRIES` and `RESTRICTED_REGIONS` in [`wrangler.jsonc`](wrangler.jsonc) and marks the page.
- The market isn't halted, neither it nor the target's market is paused, and the target fits under that market's caps, counted the way the market counts them.
- The wallet is connected and on Robinhood Chain.

Settling, stopping, cancelling and withdrawing don't depend on any of these, except a halt, which stops everything until it ends. A halt or a pause is said above every page while it lasts.

## Wallets

One Connect wallet button in the top bar opens the wallet modal. Wallets installed in the browser announce themselves and list by name. WalletConnect, for phones and wallets that live on one, joins the list when the build has a project ID. A wallet on another chain gets a button that switches it to Robinhood Chain, adding the chain with its public RPC if the wallet doesn't know it.

Every transaction estimates its gas first and sends with a margin over it, then waits for the receipt. A toast says where it is and links to the explorer, and a refusal reads as a sentence: a declined signature, too little ETH for gas, or the market's own reason, like a target that's in this week's batch.

## Link previews

Each page has its own title, description and 1200 by 630 card. The Worker writes them into the HTML, because a crawler that asks for `/app/orders` reads the HTML and never runs the app. Every build renders the cards from [`packages/brand/social/cards.ts`](../../packages/brand/social/cards.ts) into `og/`.

## Settings

At build time, from this directory's env files or the environment:

- `VITE_RPC_URL`: where the page reads the chain. `/rpc` in production and in dev, where the dev server forwards it to `ROBINHOOD_RPC_URL` from the repo's `.env`.
- `VITE_MARKET`: the market contract's address. Without it, `/app/` says Vayle isn't open yet.
- `VITE_MARKET_DEPLOY_BLOCK`: the block the market was deployed at, for reading history from the chain when there's no indexer.
- `VITE_INDEXER_URL`: the indexer's base URL. Optional.
- `VITE_MAKER_URL`: the maker's base URL, for its bid sheet at `/v1/bids`. Optional. Without it, rates are batch bids only. A value that isn't an http or https URL stops the build's app at its standby page.
- `VITE_PLACEMENT`: `open` for a build that takes new targets. Anything else, or nothing, leaves placement off.
- `VITE_WALLETCONNECT_PROJECT_ID`: turns on WalletConnect. Optional, since browser wallets work without it.

The markets come from `deployments/markets.json` and the market check from `deployments/market-check.json`, both read at build time.

On the Worker:

- `RPC_URL`, a secret set with `wrangler secret put RPC_URL`: the RPC `/rpc` forwards to.
- `RPC_FALLBACK_URL`, an optional secret: the RPC `/rpc` asks when `RPC_URL` refuses a request as too many.
- `RPC_LOG_ADDRESSES`: the addresses `/rpc` answers log queries for, comma-separated.
- `RESTRICTED_COUNTRIES` and `RESTRICTED_REGIONS`: where new targets aren't offered.
- `RPC_LIMITER`: the rate limit binding, set in `wrangler.jsonc`.

## Development

```sh
pnpm --filter @vayle/web dev:fork   # against the local fork, see tools/local-fork
pnpm --filter @vayle/web test       # formats and times, tickets, edits, caps, target lines, the week, rates, the bid sheet, the market check, market selection, disclosures and the geofence
pnpm --filter @vayle/web build
pnpm --filter @vayle/web exec wrangler dev   # the build under the Worker, with secrets from .dev.vars
```

## Deploying

```sh
pnpm --filter @vayle/web build:mainnet
pnpm --filter @vayle/web exec wrangler deploy
pnpm --filter @vayle/web exec wrangler secret put RPC_URL
```

The Worker takes `vayle.xyz` as its custom domain. [DEPLOY.md](../../DEPLOY.md) has the whole runbook.
