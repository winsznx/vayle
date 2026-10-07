# Keeper

A Cloudflare Worker that runs Vayle's weekly schedule every minute. Every call it makes is one anyone could make, and its key holds gas only. If it stops, no funds are stuck: windows extend through liveness gaps, and anyone can finalize, settle or finish a renewal batch. A week can't open without the checkpoints before its close, though, so a close with no keeper running costs that week.

## What a run does

Each run reads the chain at one block, plans what's due from that snapshot alone, and sends it:

- Liveness checkpoints from 45 minutes before each close, and `observeClose` every minute in its last 30 minutes. A week opens only if the chain was checkpointed with no gap over 5 minutes through the 30 minutes before its close, and an observation in its last 5 minutes found NVDA's oracle running. The first checkpoint after a quiet stretch records that stretch as one gap, so starting 45 minutes out puts it before the part that counts.
- Checkpoints with `observePauses` for 2 hours 30 minutes after each close, and while any window it reads is still open, so quiet time and issuer pauses are recorded where they extend a window.
- `createEpoch` after each close, until that boundary's creation deadline, with the feed's last round at or before the close as its hint.
- `finalize` for each series whose window has ended, then `settleOrder` for every order attached to a settled series.
- The renewal batches. For each price in the current week that has a bid and idle orders, once the bid window is over, it calls `openBatch`, then `countBatch` and `fillBatch` over the orders in chunks of 100, and `closeBatch` for a batch still filling when its series expires.

The 45 minutes, the 2 hours 30 minutes and the chunk of 100 are `KEEPER_LEAD`, `AFTER_CLOSE` and `CHUNK` in `src/plan.ts`. The 30 minutes is the market's `LIVENESS_LOOKBACK`, which the keeper reads from the market, and the two 5-minute limits are the market's `CLOSE_OBSERVATION_RECENCY` and the liveness contract's `GAP_THRESHOLD`.

Each action is simulated first, so a call that would revert is never sent. It's then sent with a gas limit over the estimate, from `withGasMargin` in `@vayle/market`, and the run waits for its receipt. A failed action is logged and the next run tries again. A repeated call reverts without effect, so two keepers running at once only waste gas.

## How it reads

The clients come from `keeperClients` in `src/clients.ts`, on `robinhoodChain` from `@vayle/chain-facts/chain`. Every read is pinned to the run's block, and reads that don't wait on each other go out together as one Multicall3 call of up to 32 KiB of calldata (`MULTICALL_BYTES`), so a run is a handful of RPC requests.

- The calendar's own views, `latestBoundaryAtOrBefore` and `nextCloseAfter`, place the run in the week. They go out in the same call as the market's getters and `orderCount`.
- The round search reads the feed's `latestRoundData`, then `getRoundData` 64 rounds per call, newest first, until it finds the last round at or before the close. It stops at the first round of the feed's current phase and looks back 500 rounds at most (`ROUND_WINDOW` and `MAX_ROUNDS_BACK` in `src/hint.ts`).
- Orders are read from each close until 3 days after it, or an hour past that week's batch deadline when that's later (`ORDERS_AFTER_CLOSE` and `AFTER_BATCH_DEADLINE` in `src/snapshot.ts`). `orderOf` reads go in calls of 400 (`ORDERS_PER_CALL`), all sent at once, which keeps each call far under the node's gas limit for one eth_call however long the book grows.
- A price's series ID is worked out offchain with `seriesId` from `@vayle/market`, from the chain ID and USDG in the chain facts, instead of asking the market.

Only the calendar's `NoCloseAtOrBefore` and `NoCloseAfter` reverts read as "no close". Any other failed read throws the run, and the next minute tries again, so a broken read is never mistaken for an empty calendar.

Errors are logged without the RPC's URL. The run logs each failed action with `errorText` from `@vayle/chain-facts/rpc-errors`, and the Worker rethrows a failed run through `redacted`.

## Configuration

Secrets, set with `wrangler secret put`: `ROBINHOOD_RPC_URL` and `KEEPER_KEY`. Vars, set once the contracts are deployed: `VAYLE_MARKET`, `VAYLE_LIVENESS` and `VAYLE_CALENDAR`. NVDA, its feed, USDG and the chain ID come from `deployments/robinhood-mainnet.json`, built into the Worker. A missing setting stops the run with `MissingSetting`.

Its account needs ETH for gas and nothing else. Have it running and funded more than 45 minutes before the first close. It does nothing before then, so starting it right after the deploy is fine. [DEPLOY.md](../../DEPLOY.md) covers both.

## Development

```sh
pnpm --filter @vayle/keeper test         # the planner, the round search and the snapshot rules, without a network
pnpm --filter @vayle/keeper test:chain   # the round search against the real NVDA feed, through Multicall3 as the Worker reads it; needs ROBINHOOD_RPC_URL in the environment
```

The local fork in [tools/local-fork](../../tools/local-fork) runs this keeper's `runOnce` on a simulated clock.
