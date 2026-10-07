# Market

`@vayle/market` is the TypeScript side of the market contract: the calls a holder sends, the reads that show an order's state, and the market's events decoded into rows. The [web app](../../apps/web/README.md) and the [fallback page](../../apps/fallback/README.md) build every transaction here, so both reach the same contract paths with the same calldata. The [keeper](../../services/keeper/README.md) and the [maker](../../services/maker/README.md) take their series IDs and gas limits from it, and the [indexer](../../services/indexer/README.md) its event decoding and order summaries. What each call does onchain is in the [contracts README](../../contracts/README.md).

## What's in it

| Export                                                                                                      | What it does                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `placeOrder`, `amendOrder`, `updateOrder`, `cancelOrder`, `settleOrder`, `finalize`, `exercise`, `withdraw` | Calldata for one market call, as a `Call` of `to` and `data` that any wallet can send                                                                                            |
| `approve`                                                                                                   | The token approval a new order, a larger amend or an exercise needs first                                                                                                        |
| `checkpoint`, `observeClose`                                                                                | The two public calls that keep a week on schedule, for anyone to send when the keeper is down                                                                                    |
| `CALL`, `PUT`, `OrderParams`, `AmendParams`                                                                 | Order sides, 0 to sell and 1 to buy, and order terms in raw token units and USDG base units                                                                                      |
| `withGasMargin`                                                                                             | A gas limit of the estimate plus a quarter plus `GAS_HEADROOM`, 100,000, since a call's cost depends on whether it lands in a new second or after a quiet stretch                |
| `seriesId`                                                                                                  | A series' ERC-1155 ID worked out from its terms without asking the chain, the same hash the market computes                                                                      |
| `ordersOf`, `seriesState`, `claimable`, `balanceOf`                                                         | Reads of the market's views and of token balances, each of which can be pinned to a block. `ordersOf` finds an address's orders by reading every order, with no indexer or logs. |
| `nextStep`                                                                                                  | What a holder can do with an order now: settle, finalize then settle, cancel, stop renewing, wait, or nothing                                                                    |
| `finalizeBlockedUntil`                                                                                      | Simulates `finalize` and returns the window end the market reports while the window is still open, since quiet time nobody has recorded can still extend it                      |
| `readMarketEvents`, `toMarketEvents`, `LOG_RANGE`                                                           | The market's events, decoded into one row shape with IDs as decimal strings, read `LOG_RANGE`, 10,000 blocks, per request                                                        |
| `orderSummary`, `weeksOf`, `seriesExpiries`                                                                 | Premium earned, weeks filled and the current skip streak for an order, worked out from its events                                                                                |

`src/cli.ts` prints the calldata for one action. The contracts' interface test runs a holder's whole flow through it over FFI on a mainnet fork, and checks `seriesId` against the market's own IDs.

## Tests

```sh
pnpm --filter @vayle/market test
pnpm --filter @vayle/market typecheck
```

The tests decode each call back to its arguments and selector, and cover `nextStep`, the gas margin, event decoding and order summaries, without a network.
