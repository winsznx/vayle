# Fallback page

One HTML file that reaches the market contracts through the holder's own wallet, with no Vayle server in between. It's for when the app isn't available: it lists an address's orders and settles, cancels, withdraws and exercises, using the same call builders as the app. It can also stand in for the keeper around a close, so the week still opens on time. Every action also shows its calldata, so it can be sent from any wallet or a block explorer.

## Build

```sh
pnpm --filter @vayle/fallback build
```

The build is `dist/index.html`, with its script inlined, so it works from any static host, from IPFS, or opened straight from disk. The build fails if it would produce anything else.

The market address comes from `deployments/vayle-robinhood-mainnet.json` when the build has it, and `#market=0x...` in the URL overrides it.

## How it reads the chain

Reads go through the connected wallet's provider, so the page needs no RPC URL of its own. Without a wallet, it can read from any Robinhood Chain RPC typed into the page, and then shows calldata instead of sending.

When a window looks over but nobody has checkpointed the chain in a while, the page simulates finalizing and shows the end the market reports. Quiet time keeps a window open, up to a day in total, so the page says how late it can run instead of offering a transaction that would fail.

## Keeping the week on schedule

A week opens at a close only if the chain was checkpointed, with no gap longer than 5 minutes, through the 30 minutes before it, and an observation in its last 5 minutes found NVDA's price feed running. The keeper does both, and keeps checkpointing through each exercise window so quiet time doesn't hold the window open. If it's down, the page offers the same two calls:

- Checkpoint the chain, `checkpoint()` on the liveness contract. Anyone can send one at any time. It matters from 45 minutes before a close until the close, and for 2 hours 30 minutes after it, through the exercise window of the week that ends there.
- Observe the close, `observeClose(asset)` on the market. The market only takes it in the 30 minutes before a close, so the button only shows then. Each observation is a checkpoint too.

Those numbers are the deployment's. The page reads the gap threshold, the lookback, the observation window and each week's window length from the contracts, and adds only the keeper's two margins, starting 15 minutes before the lookback and running 30 minutes past a window's usual end. It shows when the next checkpoint has to land, says when a week can no longer open and why, and turns a refusal from the market into a sentence. The section reads beside the orders, so if it fails, settling and withdrawing still work.

The page doesn't open the week itself. `createEpoch` needs the feed's last round at or before the close, found offchain, and that search isn't in a shared package yet.

## Development

```sh
pnpm --filter @vayle/fallback test   # display, exercise, schedule and refusal checks, without a network
pnpm fork up                         # a local fork to try it against, see tools/local-fork
```
