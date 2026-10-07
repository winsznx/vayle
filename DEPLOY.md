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

2. Generate ten weeks of boundaries, starting a day from now:

   ```sh
   pnpm --silent --filter @vayle/calendar boundaries "$(( $(date +%s) + 86400 ))" 10 > deployments/calendar-boundaries.json
   ```

   The calendar refuses any close less than a day after the block that schedules it, so a close within the next day would make the deploy revert `TooSoon`. Broadcast soon after generating, for the same reason.

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

6. Start the keeper at least 45 minutes before the first close. A week opens only if the keeper checkpointed the chain with no gap longer than 5 minutes through the 30 minutes before the close, and observed the close in that stretch. Otherwise `createEpoch` reverts `LivenessGapAtClose` or `CloseNotObserved` and that week doesn't open.

7. Fund the maker before the first bid window, which opens two hours after the close. It needs USDG for the premiums it bids plus the strike of every call it may end up holding, and NVDA for every put. It bids only as much as it could exercise, so an underfunded maker bids less instead of leaving in-the-money orders unfilled.

`test/deploy/DeployVayle.fork.t.sol` runs the same deploy on a fork and checks the end state: the delay, the multisig's roles, the deployer holding none, every owner, the guardian, the fee, the caps, the listing and the calendar, and a full week of trading.
