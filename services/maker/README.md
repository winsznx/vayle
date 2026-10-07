# Maker

The maker that buys the options holders write is operated by the Vayle team, and the market marks its address as team-operated. Its direct fills carry that flag in their event, and batch fills name the maker, whose flag anyone can read. This Worker is that maker. Each minute it:

- Bids into each weekly renewal batch for the buckets that have orders, at one price per series.
- Quotes orders that arrive mid-week, if quoting is on, at the same price it would bid.
- Exercises the options it holds when they finish in the money, as far as its balances pay for them.
- Withdraws what the market credits it.

It never bids or quotes for more than it could exercise. Before spending USDG on premiums it keeps back the strike of every call it holds or has bid for, and it bids on puts only as far as it holds the NVDA to deliver. A holder's order that finishes past its price fills only if the maker exercises it, so an underfunded maker bids less rather than leaving those orders unfilled.

## Funding

USDG for the premiums it bids plus the strike of every call it may hold, and NVDA for every put it may hold. The per-series limit, `MAKER_MAX_PER_SERIES`, bounds both.

## Pricing

Black-Scholes on the raw token: spot is the NVDA feed's latest answer, and the strike and expiry come from the series. Volatility, rate and edge are owner-set inputs, with no defaults. The issuer withholds 30% of NVDA's dividend equivalents and reinvests the rest into the token, so the model uses 30% of the gross dividend yield. The bid is fair value less the edge, floored to the price tick, so rounding never goes against a holder. Below one tick, the maker doesn't bid.

The maker signs the digest the market computes for each quote, so what it signs is exactly what the contract verifies.

## Configuration

Secrets: `ROBINHOOD_RPC_URL`, `MAKER_KEY`. Vars: `VAYLE_MARKET` and the `MAKER_*` inputs described in `.env.example`. A missing or malformed input stops the maker instead of falling back to a default.

## Development

```sh
pnpm --filter @vayle/maker test
```
