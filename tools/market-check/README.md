# Market check

Checks every Stock Token on Robinhood Chain against what a Vayle market needs, at one pinned block, and writes [`deployments/market-check.json`](../../deployments/market-check.json). A token lists in [`deployments/markets.json`](../../deployments/markets.json) only after it passes every check here, and `pnpm --filter @vayle/markets test` refuses a listed market whose token, uid, decimals or feed differ from its passed entry.

```sh
pnpm --filter @vayle/market-check check                 # a cap of $2,500
pnpm --filter @vayle/market-check check --cap-usd 5000  # or another cap
```

It needs `ROBINHOOD_RPC_URL` in the repo's `.env`, and prints a table of every token with the passing ones ranked by depth.

## The checks

The token list is the official registry at `api.robinhood.com/rhj/assets`, every active asset with a deployment on chain 4663. Feeds come from Chainlink's directory for the chain, matched on the token's symbol as base asset with the tokenized price product type.

| Check      | Passes when                                                                                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| feed       | A tokenized price feed exists for the token, and its proxy has no access controller, since the contracts read it directly                                                                                  |
| erc8056    | The token reports the ERC-8056 core, balances and pending interfaces                                                                                                                                       |
| multiplier | No different multiplier takes effect in the future                                                                                                                                                         |
| pauses     | Neither the token, its oracle flag nor its access registry is paused                                                                                                                                       |
| uid        | The token's uid and decimals match the registry's entry                                                                                                                                                    |
| staleness  | Over the last 5 completed sessions, the longest gap between feed updates inside the feed's market hours is within its heartbeat, and each close had a round at most 24 hours old, the contracts' own limit |
| liquidity  | Selling a cap's worth of the token for USDG on a live pool returns at least 99% of its value at the feed's price, fees included                                                                            |

Staleness and liquidity run only for tokens that pass the cheap checks above them. Each entry also records the token's price, the strike step it would get (about 2% of the price, on a 1, 2, 5 scale), its 20-session close-to-close realized volatility, and the depth it can sell within the 1% limit.

## Limits

- Depth is a lower bound from a single route through Uniswap pools, without splitting a sale across pools. Pools of a shape the sample didn't see can be missed.
- The pool search samples recent swaps instead of every pool ever created, so a run at another block can find slightly different pools.
- A feed listed under a different base asset or without a product type fails the feed check as written, even if it prices the token.

Every RPC error is printed through `errorText` from `@vayle/chain-facts/rpc-errors`, so the RPC's URL never reaches the output.
