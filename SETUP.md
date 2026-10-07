# Setup

## Requirements

- Node 24 or newer
- pnpm 11 through Corepack
- Foundry 1.7.1
- git

## Bootstrap from a clean clone

```sh
git clone --recurse-submodules https://github.com/winsznx/vayle.git
cd vayle
corepack enable
pnpm install
cp .env.example .env
```

`pnpm install` also points git at the repo's hooks. Fill in `.env`, which is gitignored. `.env.example` lists every variable with a one-line description and no values, and the hooks block any commit that adds a value to it.

If you install Foundry with foundryup, pin the version with `foundryup --install v1.7.1`.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
cd contracts
forge fmt --check
forge build
forge test
slither . --config-file slither.config.json
```

CI runs all of these on every push and pull request. Slither is optional locally.

## Commit hooks

The hooks scan staged files, commit messages, branch names and outgoing commits. They block references into the private docs folder, which is gitignored, and values in `.env.example`. They also check names from two private lists when those lists are present. A match on the first list blocks the commit, and a match on the second prints a warning.

The lists aren't in the repository. If you hold them, the hooks read them from the private docs folder at the repo root. Without them, the hooks skip the name checks and say so. CI reads them from the `DENYLIST` and `DENYLIST_COMMON` repository secrets and fails if either one is missing.

Don't bypass the hooks with `--no-verify`. The repository is public, so CI can only catch a leak after it's already pushed.

## Local fork

`pnpm fork up` runs the contracts, keeper and maker on a local fork of mainnet, and `pnpm --filter @vayle/web dev:fork` points the app at it. [tools/local-fork/README.md](tools/local-fork/README.md) covers it.

## Fork tests

Fork tests run against Robinhood Chain mainnet state. They need `ROBINHOOD_RPC_URL` set to an RPC with archive access. Without it they fail with a named error, and nothing falls back to another endpoint.
