# Chain facts

`@vayle/chain-facts` finds every outside address and chain parameter Vayle depends on, confirms each one on chain, and writes them to [`deployments/robinhood-mainnet.json`](../../deployments/robinhood-mainnet.json) with the URLs they came from and the block they were read at. Nothing in that file is typed in by hand. The [contract](../../contracts/README.md) tests, the deploy script, the apps, the services and the local fork all take NVDA, USDG, the NVDA/USD feed and the chain's parameters from it.

Every value is read at one pinned block and has to agree with an official source. NVDA comes from the issuer's Stock Token registry, where it has to be listed as active, and must match it on `uid()` and `decimals()`, with the ERC-8056 core and pending-multiplier interfaces supported. USDG is the one address that both official contract pages list and that answers `symbol()` with USDG, and its `DOMAIN_SEPARATOR` has to match its EIP-712 domain. The feed is the one tokenized NVDA price feed in the feed directory, and its proxy has to report the listed decimals and aggregator and a positive answer. The chain's largest accepted runtime and initcode, `chain.maxCodeSize` and `chain.maxInitCodeSize`, are measured by bisecting contract creations. Anything that doesn't hold fails the run with a named error from `src/errors.ts`, and nothing falls back to a default.

## Use

```sh
pnpm --filter @vayle/chain-facts resolve   # rewrite the file from the sources and the chain
pnpm --filter @vayle/chain-facts verify    # resolve again and compare with the committed file
```

Both need `ROBINHOOD_RPC_URL`, and both exit 1 when a check fails. `resolve` finds Multicall3's creation block by bisection over archive state. `verify` on an RPC without archive state, like the chain's public one, keeps the recorded creation block and says so. `verify` prints every difference and also fails on drift, a change to anything outside the values that move in normal operation, like the block, the latest feed round, the multiplier and the pause flags. `VOLATILE_PATHS` in `src/facts.ts` lists those. The [deploy runbook](../../DEPLOY.md) runs `verify` first.

| Export                                                                           | What it does                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `robinhoodChain`, from `@vayle/chain-facts/chain`                                | Robinhood Chain as a viem `Chain` built from the facts. It offers wallets the public RPC and the explorer, and names the batching contract, so reads made together go out as one call. |
| `errorText`, `withoutUrlPaths`, `redacted`, from `@vayle/chain-facts/rpc-errors` | Error text that's safe to log or post, on one line, with every URL cut to its origin so an RPC key in a path or query never leaves the process                                         |

## Tests

```sh
pnpm --filter @vayle/chain-facts test
```

They cover picking entries out of the registry and the feed directory, the ERC-8056 interface IDs against the spec's published values, the EIP-1967 slots, the USDG domain separator, the init code the size probes deploy, the diff, the chain definition and redaction, on fixed inputs and without a network. A live run against mainnet is `resolve` or `verify` itself.
