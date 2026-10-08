# Setup

## Requirements

- Node 24 or newer
- pnpm 11 through Corepack
- Foundry 1.7.1
- git
- A Robinhood Chain mainnet RPC, for fork tests, the local fork and the chain facts check. The chain's public one works

If you install Foundry with foundryup, pin the version with `foundryup --install v1.7.1`.

## Bootstrap from a clean clone

```sh
git clone --recurse-submodules https://github.com/winsznx/vayle.git
cd vayle
corepack enable
pnpm install
cp .env.example .env
```

`pnpm install` also points git at the repo's hooks. Fill in `.env`, which is gitignored. `.env.example` lists every variable with a one-line description and no values, and the hooks block any commit that adds a value to it.

`ROBINHOOD_RPC_URL` is the one value you need to work on Vayle. The chain's public RPC, `https://rpc.mainnet.chain.robinhood.com` (`chain.publicRpcUrl` in the chain facts), does everything here. It keeps state for about the last 6,000 blocks, roughly 25 minutes, so fork tests fork one recent block for a whole run and the local fork lasts that long before it has to start again. It answers `eth_getLogs` over 10,000 blocks, which is how far the indexer and the app read at a time. An RPC with archive state lifts both limits. The rest of `.env` is for deploying and running the services, which [DEPLOY.md](DEPLOY.md) covers.

## Checks

```sh
pnpm lint        # ESLint and Prettier
pnpm typecheck
pnpm build
pnpm test        # every package's unit tests, without a network
pnpm guard       # the tree scan the commit hooks run
pnpm test:contracts   # forge test with every fork test on one recent block
cd contracts
forge fmt --check
forge build
slither . --config-file slither.config.json
```

`pnpm -r --if-present test:chain` runs the few TypeScript tests that read the live chain, like the keeper's search for a feed round. CI runs all of these on every push and pull request. Slither is optional locally.

## Commit hooks

The hooks scan staged files, commit messages, branch names and outgoing commits. They block references into the private docs folder, which is gitignored, and values in `.env.example`. They also check names from two private lists when those lists are present. A match on the first list blocks the commit, and a match on the second prints a warning.

The lists aren't in the repository. If you hold them, the hooks read them from the private docs folder at the repo root. Without them, the hooks skip the name checks and say so. CI reads them from the `DENYLIST` and `DENYLIST_COMMON` repository secrets and fails if either one is missing.

Don't bypass the hooks with `--no-verify`. The repository is public, so CI can only catch a leak after it's already pushed.

## Local fork

`pnpm fork up` runs the contracts, keeper and maker on a local fork of mainnet, and `pnpm --filter @vayle/web dev:fork` points the app at it. [tools/local-fork/README.md](tools/local-fork/README.md) covers it.

## Fork tests

Fork tests run against Robinhood Chain mainnet state through `ROBINHOOD_RPC_URL`. Without it they fail with a named error, and nothing falls back to another endpoint. `pnpm test:contracts` pins `FORK_BLOCK` to the chain's current block for the whole run and passes its arguments to `forge test`. The chain makes about four blocks a second, so without a pinned block each test forks a block of its own and every read goes to the RPC again. `FORK_MARKET=SPY pnpm test:contracts` runs every suite against another market in `deployments/markets.json`.
