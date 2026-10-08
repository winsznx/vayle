# Maker

The maker that buys the options holders write is operated by the Vayle team, and this Worker is it. The market marks its address as team-operated, so every fill it makes is tagged onchain: `QuoteFilled` carries the flag for its quotes, and `BatchOpened` carries it for each renewal batch filled at its bid. The owner also approves it as a batch bidder, and the market takes renewal bids only from approved makers.

It trades every market in `deployments/markets.json`, each side only where the file enables it. Each minute it:

- Bids into each market's weekly renewal batch while the bid window is open, one price per series, for the prices that have idle orders. A series nobody has registered yet gets registered on one run and bid on the next. The bid window closes at the week's batch deadline, so a market's first week, whose deadline is its opening, has none.
- Quotes orders that arrive mid-week, if quoting is on, at the same price it would bid. Quoting starts once the week's batch deadline has passed, which in a market's first week is the moment it opens, and stops an hour before the series expires, and each quote lives ten minutes (`RFQ_CUTOFF` and `QUOTE_LIFETIME` in `src/plan.ts`). It skips orders frozen in a batch and orders whose minimum is above its price, and registers a series an order needs on one run and quotes it on the next.
- Exercises the options it holds that finished in the money at their close, as far as its balances pay for them.
- Withdraws what the market credits it, and keeps the market approved to move its USDG and each market's token.

It never bids or quotes for more than it could exercise. Before spending USDG on premiums it keeps back the strike of every call it holds or has bid for, in any market. A buy target is a put, which it exercises by delivering the market's token, so it bids or quotes on one only as far as its inventory of that token covers: what's in its wallet plus what the market holds for it to withdraw, less what the puts it holds or has bid for keep back. A holder's order that finishes past its price fills only if the maker exercises it, so an underfunded maker bids less rather than leaving those orders unfilled.

## Exercising on the close

A week's fill is decided by its close. For each series it holds in an open exercise window, the maker reads the market's feed's last round at or before the series' expiry, found the way the keeper finds an epoch's round hint: back from the latest round, 64 rounds a call, newest first, stopping at the feed's phase start and never more than 500 rounds back (`ROUND_WINDOW` and `MAX_ROUNDS_BACK` in `src/close.ts`). A call is in the money when that answer is strictly above its strike, and a put when it's strictly below. In the money at the close, it exercises as much as its balances pay for, whatever the price does afterwards. Not in the money at the close, it never exercises that series. With no round at or before the close, or the feed's decimals unread, it holds off.

## Funding

USDG for the premiums it bids, plus the strike of every call it may hold. The protocol fee is paid on top of premiums and starts at zero. Each market's token for every put it may hold, and ETH for gas. Each side's `seriesOpenInterest` in the markets file bounds what it buys in one series, so it bounds both amounts per series. Fund it before a market's first week opens, since it quotes from then, and keep its address the `TEAM_MAKER` the deploy flagged and approved, or the market refuses its batch bids with `NotABatchBidder`.

## Pricing

Black-Scholes on the raw token: spot is the market's feed's latest answer, once the price guard below passes it, and the strike and expiry come from the series. Volatility is the market's `maker.volBps` in the markets file. Rate, dividend yield and edge are owner-set inputs, with no defaults, and the same for every market. The issuer withholds 30% of a Stock Token's dividend equivalents and reinvests the rest into the token, so the model uses 30% of the gross dividend yield (`WITHHELD_SHARE` in `src/pricing.ts`). The bid is fair value less the edge, floored to the market's price tick, so the maker never bids above its own price. Below one tick, it doesn't bid.

## Signing quotes

The maker builds each quote's EIP-712 hash itself, over the domain `Vayle`, version `1`, the chain ID from the chain facts and the market's address, and signs that hash. Before signing it asks the market for its `quoteDigest` of the same quote and refuses with `DigestMismatch` when the two differ. So an RPC can't get it to sign some other quote, and a market whose domain isn't the expected one gets no signature. A quote is open to any holder, its nonce comes from the clock, and it can't outlive its series.

## When it stands down

It prices a market only on a round it trusts. When that market's oracle is paused, its feed or the flag can't be read, the feed's decimals differ from the markets file, the exchange calendar doesn't cover the date, or the feed's latest round is stamped after the block it was read at, older than the feed's session allows, not positive, or under half or over one and a half times this week's reference price, the maker skips registering, bidding and quoting in that market for that run and logs one line saying why, as `maker: no bids or quotes for <symbol> this run. <reason>: <detail>`. The other markets go ahead. A feed publishes from 20:00 ET the evening before each trading day until 20:00 ET on it, so weekends and exchange holidays don't age a round: while the session is open a round can be at most its heartbeat old, a day at most, and once it has been open for a quarter hour the round has to come from it (`ADAPTER_MAX_AGE` and `REOPEN_GRACE` in `src/guard.ts`).

Approving and withdrawing carry on either way. So does exercising, which judges the money on the close whatever the guard made of the latest price.

## Markets and their listings

At the start of every run the maker reads each market's listing from the token registry, `asset(token)`, in the same call as its other first reads, and compares its uid, feed, decimals, feed decimals, lot, price tick, strike tick and strike range with the file. A market whose listing differs, that the registry doesn't list, or whose token refuses the maker's balance and allowance reads, is left out of that run: no bids, quotes, exercises, approvals or withdrawals in it. The run logs which field differs, as `maker: <symbol> skipped this run: ...`. One bad market never stops the others.

## How it reads

Its clients come from `makerClients` in `src/clients.ts`: `robinhoodChain` from `@vayle/chain-facts/chain`, reads batched through Multicall3 at up to 16 KiB of calldata per call (`MULTICALL_BYTES`), three retries per request, and the wallet on the same transport. Every read in a run is pinned to one block, and reads that don't wait on each other go out together, every market's in the same calls, so a run is a handful of RPC requests whatever the number of markets. It reads the block, then one call for its balances, allowances, claims, the caps, the listings and the price inputs of every market, then one for the epochs and the order book, and one for what depends on those. While a series it holds is in its exercise window, one more call reads that close's round. A long order book adds a call for about every 450 orders, the 36-byte `orderOf` calls that fit in 16 KiB. Series IDs come from `seriesId` in `@vayle/market`, and the targets a week lists from its reference price, strike tick and band, rather than calls to the market.

A run's reads take the same number of requests for one market or two: 3 with nothing on the book, 4 with orders, 5 while a held series is in its window, and 4 for the bid sheet. `test/reads.test.ts` pins these against a JSON-RPC endpoint in memory. Each action it sends adds its own simulation, estimate, send and receipt.

A price read that fails is kept as the guard's reason instead of failing the run. A request that fails takes every read in it, and the run stops there, as it does when the RPC is down. Errors are logged without the RPC's URL, through `errorText` and `redacted` from `@vayle/chain-facts/rpc-errors`.

## The bid sheet

`GET /v1/bids` on the Worker's URL answers with what the maker would pay right now for each target the current week lists, and how much it would buy. It's computed by the same snapshot, price guard and pricing as a mid-week quote, signs nothing and sends nothing.

```text
{
  computedAt: number                            block time the sheet was priced at, epoch seconds
  source: { chainId: number, market: string, block: number }
  markets: [
    {
      symbol: string                            as in the markets file
      token: string                             the Stock Token's address
      expiry: number                            when the week ends, epoch seconds
      round: { id: string, updatedAt: number }  the feed round the premiums were priced from
      volBps: number                            the volatility priced with
      sell: [{ target: string, premium: string, maxAmount: string }]
      buy:  [{ target: string, premium: string, maxAmount: string }]
    }
  ]
}
```

- `source` names the chain, the market and the block every number was read at. Round IDs and amounts are decimal strings, since they pass 2^53.
- A market appears once it has a week and a price the guard passes.
- `sell` lists sell targets (calls) and `buy` buy targets (puts), lowest target first. `target` and `premium` are in USDG base units per whole token, so a target of `245000000` is $245. `maxAmount` is in the token's raw units, 10^decimals to a whole token: the most the maker would buy from one order at that target now, within one fill's cap, the series' room under its cap, the side's open interest in the markets file and what its balances cover. Targets share those balances, so the sizes don't add up across targets.
- A side lists nothing while the markets file disables it, outside the hours the maker quotes, or with quoting off, and leaves out any target the maker wouldn't buy any of.

Every response is cached for 60 seconds with the Workers cache, under one key whatever the query string, so traffic can't multiply RPC calls: the chain is read at most once a minute in each Cloudflare location. A read that fails answers 503 with `{ "error": "..." }`, its text cut by `errorText`, and goes into the cache with the same minute, so a broken RPC isn't asked again on every request.

Browsers may read it from `https://vayle.xyz`, `http://localhost:5173` and `http://localhost:5191` (`ALLOWED_ORIGINS` in `src/http.ts`). Any other method than GET answers 405, and any other path 404.

## Configuration

Secrets, set with `wrangler secret put`: `ROBINHOOD_RPC_URL` and `MAKER_KEY`. Vars: `VAYLE_MARKET`, `VAYLE_REGISTRY` and the pricing inputs.

| Setting                    | What it is                                                                         | Accepted                        |
| -------------------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| `MAKER_EDGE_BPS`           | How far under fair value the maker bids                                            | Whole basis points, 0 to 9,999  |
| `MAKER_DIVIDEND_YIELD_BPS` | The gross annual dividend yield it assumes for every market, of which it keeps 30% | Whole basis points, 0 to 10,000 |
| `MAKER_RATE_BPS`           | Annual USDG rate                                                                   | Whole basis points, 0 to 10,000 |
| `MAKER_RFQ`                | `on` to quote new orders mid-week, `off` to bid only into the weekly batch         | `on` or `off`                   |

Each market's volatility and per-series limit come from `deployments/markets.json` (`maker.volBps` and each side's `seriesOpenInterest`), with its token, feed, grid and which sides it trades. USDG with its decimals and the chain ID come from `deployments/robinhood-mainnet.json`. Both files are built into the Worker. A missing or malformed input stops the maker with `MissingSetting` or `BadSetting` instead of falling back to a default. The Worker reads vars and secrets the same way, so the pricing inputs can be secrets if they shouldn't sit in the public repo's `wrangler.toml`.

## Development

```sh
pnpm --filter @vayle/maker test
```

The tests cover pricing against textbook values, the guard and the feed's sessions on real rounds and the real exchange calendar, the plan, the close search, the bid sheet and its route, the snapshot and its request count, the clients and quote signing, without a network. The local fork in [tools/local-fork](../../tools/local-fork) runs this maker's `runOnce` on a simulated clock.
