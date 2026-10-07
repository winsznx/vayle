# ABIs

`@vayle/abi` holds the ABIs of the five contracts Vayle deploys, generated from the forge artifacts so no TypeScript can drift from the [contracts](../../contracts/README.md). Each one is exported `as const`, so viem types every call, return value, error and event from it. [`packages/market`](../market/README.md), the apps, the services and the local fork all import their ABIs from here.

## Exports

| Export                  | Contract             |
| ----------------------- | -------------------- |
| `vayleMarketAbi`        | `VayleMarket`        |
| `livenessCheckpointAbi` | `LivenessCheckpoint` |
| `sessionCalendarAbi`    | `SessionCalendar`    |
| `stockTokenRegistryAbi` | `StockTokenRegistry` |
| `priceAdapterAbi`       | `PriceAdapter`       |

## Regenerating

The files in `src/generated` are written by `src/generate.ts` from `contracts/out`, never by hand. After changing a contract:

```sh
(cd contracts && forge build)
pnpm --filter @vayle/abi generate   # rewrite src/generated from the artifacts
pnpm --filter @vayle/abi check      # fail with AbiOutOfDate if a committed file differs
```

Both stop with `ArtifactMissing` when the contracts haven't been built. CI builds the contracts and runs the check, so a contract change that ships without regenerated ABIs fails.

## Tests

```sh
pnpm --filter @vayle/abi test
```

They check how contract names become module names and constants, and that the market's ABI has the guard events the watcher listens for.
