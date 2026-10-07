# Maker

The maker that buys the options holders write is operated by the Vayle team, and this Worker is it. The market marks its address as team-operated, so every fill it makes is tagged onchain: `QuoteFilled` carries the flag for its quotes, and `BatchOpened` carries it for each renewal batch filled at its bid. The owner also approves it as a batch bidder, and the market takes renewal bids only from approved makers. Each minute it:

- Bids into each weekly renewal batch while the bid window is open, one price per series, for the prices that have idle orders. A series nobody has registered yet gets registered on one run and bid on the next.
- Quotes orders that arrive mid-week, if quoting is on, at the same price it would bid. Quoting starts once the week's batch deadline has passed and stops an hour before the series expires, and each quote lives ten minutes (`RFQ_CUTOFF` and `QUOTE_LIFETIME` in `src/plan.ts`). It skips orders frozen in a batch and orders whose minimum is above its price.
- Exercises the options it holds that finish in the money, as far as its balances pay for them.
- Withdraws what the market credits it, and keeps the market approved to move its USDG and NVDA.

It never bids or quotes for more than it could exercise. Before spending USDG on premiums it keeps back the strike of every call it holds or has bid for, and it bids on puts only as far as it holds the NVDA to deliver. A holder's order that finishes past its price fills only if the maker exercises it, so an underfunded maker bids less rather than leaving those orders unfilled.

## Funding

USDG for the premiums it bids, plus the strike of every call it may hold. The protocol fee is paid on top of premiums and starts at zero. NVDA for every put it may hold, and ETH for gas. The per-series limit, `MAKER_MAX_PER_SERIES`, bounds both amounts in each series. Fund it before the first bid window, two hours after the first close, and keep its address the `TEAM_MAKER` the deploy flagged and approved, or the market refuses its batch bids with `NotABatchBidder`.

## Pricing

Black-Scholes on the raw token: spot is the NVDA feed's latest answer, once the price guard below passes it, and the strike and expiry come from the series. Volatility, rate, dividend yield and edge are owner-set inputs, with no defaults. The issuer withholds 30% of NVDA's dividend equivalents and reinvests the rest into the token, so the model uses 30% of the gross dividend yield (`WITHHELD_SHARE` in `src/pricing.ts`). The bid is fair value less the edge, floored to the market's price tick, so the maker never bids above its own price. Below one tick, it doesn't bid.

## Signing quotes

The maker builds each quote's EIP-712 hash itself, over the domain `Vayle`, version `1`, the chain ID from the chain facts and the market's address, and signs that hash. Before signing it asks the market for its `quoteDigest` of the same quote and refuses with `DigestMismatch` when the two differ. So an RPC can't get it to sign some other quote, and a market whose domain isn't the expected one gets no signature. A quote is open to any holder, its nonce comes from the clock, and it can't outlive its series.

## When it stands down

It prices only on a round it trusts. When the token's oracle is paused, the feed or the flag can't be read, the feed's decimals differ from the chain facts, the exchange calendar doesn't cover the date, or the feed's latest round is stamped after the block it was read at, older than the feed's session allows, not positive, or under half or over one and a half times this week's reference price, the maker skips registering, bidding and quoting for that run and logs one line saying why. The feed publishes from 20:00 ET the evening before each trading day until 20:00 ET on it, so weekends and exchange holidays don't age a round: while the session is open a round can be at most a day old, and once it has been open for a quarter hour the round has to come from it (`ADAPTER_MAX_AGE` and `REOPEN_GRACE` in `src/guard.ts`).

Approving and withdrawing carry on either way. So does exercising, which judges the money on the feed's latest positive answer whatever the guard made of it. With no positive answer to judge by, it holds off exercising too.

## How it reads

Its clients come from `makerClients` in `src/clients.ts`: `robinhoodChain` from `@vayle/chain-facts/chain`, reads batched through Multicall3 at up to 16 KiB of calldata per call (`MULTICALL_BYTES`), three retries per request, and the wallet on the same transport. Every read in a run is pinned to one block, and reads that don't wait on each other go out together, so a run is a handful of RPC requests. It reads the block, then one call for its balances, allowances, claims, the caps and the price inputs, then one for the epoch and the order book, and one for what depends on those. A long order book adds a call for about every 450 orders, the 36-byte `orderOf` calls that fit in 16 KiB. Series IDs come from `seriesId` in `@vayle/market` rather than a call to the market.

A price read that fails is kept as the guard's reason instead of failing the run. A request that fails takes every read in it, and the run stops there, as it does when the RPC is down. Errors are logged without the RPC's URL, through `errorText` and `redacted` from `@vayle/chain-facts/rpc-errors`.

## Configuration

Secrets, set with `wrangler secret put`: `ROBINHOOD_RPC_URL` and `MAKER_KEY`. Vars: `VAYLE_MARKET` and the pricing inputs.

| Setting                    | What it is                                                                 | Accepted                        |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| `MAKER_VOL_BPS`            | Annualized volatility, so 4500 is 45%                                      | Whole basis points, 1 to 50,000 |
| `MAKER_EDGE_BPS`           | How far under fair value the maker bids                                    | Whole basis points, 0 to 9,999  |
| `MAKER_DIVIDEND_YIELD_BPS` | NVDA's gross annual dividend yield, of which the model keeps 30%           | Whole basis points, 0 to 10,000 |
| `MAKER_RATE_BPS`           | Annual USDG rate                                                           | Whole basis points, 0 to 10,000 |
| `MAKER_MAX_PER_SERIES`     | The most it buys in one series, in raw units, where 1 NVDA is 10^18        | A whole number                  |
| `MAKER_RFQ`                | `on` to quote new orders mid-week, `off` to bid only into the weekly batch | `on` or `off`                   |

NVDA, the feed with its decimals and heartbeat, USDG with its decimals, and the chain ID come from `deployments/robinhood-mainnet.json`, built into the Worker. A missing or malformed input stops the maker with `MissingSetting` or `BadSetting` instead of falling back to a default. The Worker reads vars and secrets the same way, so the pricing inputs can be secrets if they shouldn't sit in the public repo's `wrangler.toml`.

## Development

```sh
pnpm --filter @vayle/maker test
```

The tests cover pricing against textbook values, the guard and the feed's sessions on real rounds and the real exchange calendar, the plan, the snapshot, the clients and quote signing, without a network. The local fork in [tools/local-fork](../../tools/local-fork) runs this maker's `runOnce` on a simulated clock.
