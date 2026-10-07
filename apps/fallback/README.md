# Fallback page

One HTML file that reaches the market contracts through the holder's own wallet, with no Vayle server in between. It's for when the app isn't available: it lists an address's orders and settles, cancels, withdraws and exercises, using the same call builders as the app. Every action also shows its calldata, so it can be sent from any wallet or a block explorer.

## Build

```sh
pnpm --filter @vayle/fallback build
```

The build is `dist/index.html`, with its script inlined, so it works from any static host, from IPFS, or opened straight from disk. The build fails if it would produce anything else.

The market address comes from `deployments/vayle-robinhood-mainnet.json` when the build has it, and `#market=0x...` in the URL overrides it.

## How it reads the chain

Reads go through the connected wallet's provider, so the page needs no RPC URL of its own. Without a wallet, it can read from any Robinhood Chain RPC typed into the page, and then shows calldata instead of sending.

When a window looks over but nobody has checkpointed the chain in a while, the page simulates finalizing and shows the end the market reports. Quiet time keeps a window open, up to a day in total, so the page says how late it can run instead of offering a transaction that would fail.

## Development

```sh
pnpm --filter @vayle/fallback test   # display and exercise checks, without a network
pnpm fork up                         # a local fork to try it against, see tools/local-fork
```
