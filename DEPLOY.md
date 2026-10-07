# Deploying Vayle

The deploy script creates every contract owned by a timelock that starts with no delay, configures them through that timelock in one batch, raises the delay, gives the timelock's roles to the multisig and removes the deployer's. When it finishes, the deploy key controls nothing.

## Inputs

- `deployments/robinhood-mainnet.json`: NVDA, its feed and USDG, resolved and verified by `pnpm --filter @vayle/chain-facts verify`.
- `deployments/calendar-boundaries.json`: the weekly closes to schedule, with their creation deadlines.
- The deploy-only variables in `.env.example`.

## Steps

1. Verify the chain facts against the live chain:

   ```sh
   pnpm --filter @vayle/chain-facts verify
   ```

2. Generate ten weeks of boundaries from now:

   ```sh
   pnpm --silent --filter @vayle/calendar boundaries "$(date +%s)" 10 > deployments/calendar-boundaries.json
   ```

3. Check the multisig and guardian addresses on the explorer, then rehearse the deploy against a fork of mainnet without broadcasting:

   ```sh
   cd contracts
   forge script script/DeployVayle.s.sol --rpc-url robinhood
   ```

   `pnpm fork up` goes further: it broadcasts the same script to a local fork and runs a week on it with the keeper and maker. See [tools/local-fork/README.md](tools/local-fork/README.md).

4. Broadcast:

   ```sh
   forge script script/DeployVayle.s.sol --rpc-url robinhood --broadcast --slow
   ```

   forge warns that the market is over Ethereum's 24,576-byte contract size limit and asks whether to continue. The chain's limit is 98,304 bytes, `chain.maxCodeSize` in the chain facts, and `test/Deployables.t.sol` checks every contract against it, so continue.

   The script writes the deployed addresses to `deployments/vayle-robinhood-mainnet.json`.

5. Give the watcher the market, liveness, calendar and registry addresses and the deploy block.

`test/deploy/DeployVayle.fork.t.sol` runs the same deploy on a fork and checks the end state: the delay, the multisig's roles, the deployer holding none, every owner, the guardian, the fee, the caps, the listing and the calendar, and a full week of trading.
