# Local fork

Runs Vayle on a local anvil fork of Robinhood Chain mainnet, with the week moving on a simulated clock. The deploy, keeper and maker are the production code. The fork broadcasts the deploy script through `DeployFork`, which only moves its input and output files to `deployments/fork/`, and runs the keeper and maker once a tick the way their crons would, on the same clients their Workers build.

## Use

```sh
pnpm fork up                        # start the fork, deploy, fund a holder, open the first week
pnpm --filter @vayle/web dev:fork   # the app, pointed at the fork
pnpm fork advance                   # the next moment of the week
pnpm fork advance 30                # or 30 minutes ahead
pnpm fork advance --without-keeper  # as if the keeper had died, to try the fallback page
```

`pnpm fork up` stays in the foreground, and Ctrl-C stops the fork. It needs `ROBINHOOD_RPC_URL` in `.env`, pointing at an RPC with archive state, and anvil and forge on the path.

Each `pnpm fork advance` goes to the next of these:

| When it runs          | It stops                                                             |
| --------------------- | -------------------------------------------------------------------- |
| Before the first week | 5 minutes after the next close, once the keeper has opened the week  |
| Before the bid window | 15 minutes into it, once the maker has bid                           |
| In the bid window     | 20 minutes after it, once the keeper has run the batch               |
| After the batch       | 20 minutes after the week's exercise window, with the next week open |

To use the app, add a network to your wallet with RPC URL `http://127.0.0.1:8545` and chain ID 4663, and import the holder key from `deployments/fork/accounts.json`. The holder starts with 10 NVDA and 10,000 USDG.

## What's real and what isn't

- Contracts, tokens and the feed are mainnet state at the fork block. Balances move from a real holder's account, impersonated.
- Keys are generated for each fork and are worthless anywhere else. The multisig is a stand-in address with placeholder code, because the deploy requires a contract there.
- The NVDA/USD feed doesn't update on a fork, so before each close the tool writes one round into the aggregator's storage that repeats the latest real answer. Every write is printed and logged to `deployments/fork/feed-writes.jsonl`, and the tool stops if the aggregator's storage doesn't match the layout it expects.
- The maker's pricing inputs are illustrative. The real ones are the maker Worker's settings.
- Because the feed only moves at closes here, the maker stands down from mid-week quotes once the round is older than a live feed's would be, and says so each run. Batch bids at the close aren't affected.
- In fork mode, the app's dev server serves placeholder disclosures and the fork's env file sets `VITE_PLACEMENT=open`, so the order ticket works. Builds never include the placeholder disclosures. The env file also names the market's deploy block, so the app reads history straight from the fork without an indexer.

## Limits

A fork reads each account from the forked RPC the first time something touches it. An RPC that keeps only recent state, like the public one, can't answer once the fork block is a few minutes old, so use one with archive state. The fork also loads Multicall3 as it starts, since the app batches its reads through it, and mines a few blocks of its own, so fee estimates read the fork's own blocks instead of asking the RPC about old ones.
