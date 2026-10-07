# Deploying Vayle

This is the whole deploy in order: the contracts, the database, the four services, the site and the fallback page. Run every command from the repo root. You need a clone bootstrapped as [SETUP.md](SETUP.md) describes, with Node 24, pnpm and Foundry 1.7.1, and the Supabase CLI for step 10.

The contracts go out in one forge script, `contracts/script/DeployVayle.s.sol`. It deploys every contract owned by a timelock that starts with no delay, configures them through that timelock in one batch, raises the delay, gives the timelock's roles to the multisig and removes the deployer's. When it finishes, the deploy key controls nothing.

Secrets live in `.env`, which git ignores, and in each Worker's own secrets. forge reads the `.env` in the directory it runs from, so the forge commands here run from the repo root and point at the Foundry project with `--root contracts`. Run from inside `contracts/`, they'd miss `.env`. cast takes the RPC URL on its command line, so load it into your shell once:

```sh
export ROBINHOOD_RPC_URL="$(node --env-file=.env -p 'process.env.ROBINHOOD_RPC_URL')"
```

## 1. Check the chain facts

```sh
node --env-file=.env packages/chain-facts/src/cli.ts verify
```

This is `pnpm --filter @vayle/chain-facts verify` with `.env` loaded, which pnpm doesn't do on its own. It resolves NVDA, USDG, the NVDA/USD feed and Multicall3 from their official sources again, reads each one on chain at a single block, and compares the result with `deployments/robinhood-mainnet.json`. The deploy script lists NVDA from that file, and every service and the app read it too.

The last line should say `0 drifted`, and the command should exit 0. Lines that start with `changed` are values that move by themselves: the block, the feed's latest round, NVDA's multiplier and the pause flags. Read them anyway, because a pause or a pending multiplier change is worth knowing about before a deploy. A `DRIFT` line means an address, decimals, an implementation or a domain changed. Stop and find out why before going on.

## 2. Check the RPC

`ROBINHOOD_RPC_URL` is the private Robinhood Chain RPC that the chain facts check, forge, the fork tests and the services all use. It has to serve three things:

- Archive state, because the chain facts check and the fork tests read state from past blocks.
- `eth_getLogs` over 10,000 blocks, because the indexer reads the market's logs that many blocks at a time, and so does the app when it reads history itself (`LOG_RANGE` in `packages/market/src/history.ts`).
- `eth_feeHistory` for the latest block, because forge prices the deploy's transactions with it.

This asks the RPC for each one:

```sh
node --env-file=.env --input-type=module -e '
const ask = async (method, params) => {
  const response = await fetch(process.env.ROBINHOOD_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
  return body.error === undefined ? { ok: true, result: body.result } : { ok: false, why: body.error.message };
};
const latest = BigInt((await ask("eth_blockNumber", [])).result);
const range = { fromBlock: `0x${(latest - 9999n).toString(16)}`, toBlock: `0x${latest.toString(16)}` };
const code = await ask("eth_getCode", ["0xcA11bde05977b3631167028862bE2a173976CA11", "0x1"]);
const logs = await ask("eth_getLogs", [{ address: "0x0000000000000000000000000000000000000001", ...range }]);
const fees = await ask("eth_feeHistory", ["0x1", "latest", []]);
console.log("archive", code.ok && code.result !== "0x" ? "ok" : `refused: ${code.why ?? "no code at block 1"}`);
console.log("logs", logs.ok ? "ok" : `refused: ${logs.why}`);
console.log("feeHistory", fees.ok ? "ok" : `refused: ${fees.why}`);
'
```

All three lines should end in `ok`. A refusal prints the RPC's own words. The archive check reads Multicall3's code at block 1, which the chain facts record as there since block 0, and the logs check asks for 10,000 blocks of an address that never logs. The chain's public RPC, `chain.publicRpcUrl` in the chain facts, fails the archive check.

## 3. Make the keys

```sh
cast wallet new
```

This prints a new address and private key. Make one for the deploy alone, and put its key in `.env` as `DEPLOYER_KEY` and nowhere else. It pays the deploy's gas and nothing more, and step 14 sweeps it and throws it away.

Make the keeper's and the maker's keys the same way, as `KEEPER_KEY` and `MAKER_KEY` in `.env`. They become Worker secrets in step 11. The keeper's account only ever holds gas. The maker's holds the maker's USDG and NVDA too, and its address is the `TEAM_MAKER` in step 4:

```sh
cast wallet address "$(node --env-file=.env -p 'process.env.MAKER_KEY')"
```

## 4. Fill in the deploy settings

The deploy script reads these from `.env`:

| Variable         | What it is                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYER_KEY`   | The fresh key from step 3.                                                                                                                                                                                                                                                                                                         |
| `MULTISIG`       | The multisig that ends up owning everything through the timelock. The script reverts `MultisigHasNoCode` for an address without code, but it can't tell your multisig from anyone else's, so open the address on the explorer first. The deployer gives up its roles in the same broadcast, so a wrong address means a new deploy. |
| `GUARDIAN`       | The address of the guardian, a key you hold apart from the others. It can pause new orders, for the whole market or for NVDA, and halt everything for up to 72 hours (`HALT_DURATION` in `contracts/src/core/MarketGuard.sol`). It can't move funds.                                                                               |
| `FEE_RECIPIENT`  | Where protocol fees are credited. The fee starts at zero, and the multisig can raise it through the timelock to at most 5% of the premium (`MAX_FEE_BPS` in `contracts/src/core/QuoteSettlement.sol`).                                                                                                                             |
| `TEAM_MAKER`     | The maker key's address, from step 3. The deploy flags it as team-operated and approves it as a batch bidder. The market takes renewal bids only from approved makers and refuses the rest with `NotABatchBidder`.                                                                                                                 |
| `TIMELOCK_DELAY` | The timelock's delay in seconds, as plain digits. Every owner change waits this long. It has to outlast the longest week plus its exercise window, so the script sets a floor of 8 days and 6 hours, 712800 seconds (`MIN_TIMELOCK_DELAY`), and reverts `DelayTooShort` below it.                                                  |
| `CALL_CAPS`      | Four comma-separated numbers for sell orders, in raw units, where 1 NVDA is 10^18 (`nvda.decimals` in the chain facts): the total size of all open orders, the size per wallet, the open interest per series, and the size per fill.                                                                                               |
| `PUT_CAPS`       | The same four for buy orders. `0,0,0,0` keeps buy orders closed.                                                                                                                                                                                                                                                                   |

The script takes NVDA, its uid, the NVDA/USD feed and USDG from the chain facts, and the closes from step 5. The order grid is fixed in the script: lots of 0.01 NVDA, premiums on a tick of 0.0001 USDG, and strikes 5 USDG apart within 10% of the week's reference price (`LOT`, `PRICE_TICK`, `STRIKE_TICK` and `STRIKE_RANGE_BPS`).

## 5. Generate the calendar boundaries

```sh
pnpm --silent --filter @vayle/calendar boundaries "$(( $(date +%s) + 86400 + 3 * 3600 ))" 10 > deployments/calendar-boundaries.json
```

This writes the first ten weekly closes after a day and three hours from now, each with its creation deadline, the Monday 09:30 ET after it. They come from the exchange calendar in `packages/calendar`, so early closes and holiday weeks are already in them.

The first close has to be more than a day after the block the deploy lands in. The calendar refuses anything sooner (`MIN_LEAD` in `contracts/src/calendar/SessionCalendar.sol`), and the deploy's configuration batch would revert `TooSoon`. Starting a day and three hours out leaves three hours to broadcast. If more time than that passes, generate the file again.

Check the closes in New York time:

```sh
node -p 'require("./deployments/calendar-boundaries.json").map((b) => new Date(b.close * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })).join("\n")'
```

The first line is the close the first week opens at. Each close is at 4:00 PM, or 1:00 PM on an early close.

## 6. Dry run

```sh
forge script contracts/script/DeployVayle.s.sol:DeployVayle --root contracts --rpc-url robinhood
```

`robinhood` is the RPC alias in `contracts/foundry.toml`, and it reads `ROBINHOOD_RPC_URL`. The dry run runs the whole deploy against the chain's current state and sends nothing. It works before the deployer has any ETH, and it writes no address file. Only a broadcast writes `deployments/vayle-robinhood-mainnet.json`.

It should print `SIMULATION COMPLETE`. Before that, forge prints an `Error:` line saying `VayleMarket` is above the contract size limit. That one's expected. forge measures against Ethereum's 24,576 bytes, while this chain allows 98,304 (`chain.maxCodeSize` in the chain facts), and `contracts/test/Deployables.t.sol` checks every contract against the chain's limit. A real refusal names itself, like `MultisigHasNoCode`, `DelayTooShort`, `NoBoundaries` or the calendar's `TooSoon`.

Write down the `Estimated amount required` line. It's forge's estimate, in ETH, of what the deploy costs at the current gas price.

Two longer rehearsals run the same deploy code. `forge test --root contracts --match-path "test/deploy/*"` deploys on a fork of mainnet and checks the end state and a full week of trading. `pnpm fork up` broadcasts the script to a local fork and runs weeks on it with the production keeper and maker, as [tools/local-fork/README.md](tools/local-fork/README.md) describes.

## 7. Fund the deployer

Send the deployer's address a few times the dry run's estimate, in ETH on Robinhood Chain. The margin covers a gas price that rises before the broadcast, so the deploy doesn't run dry halfway. Check what arrived:

```sh
cast balance "$(cast wallet address "$(node --env-file=.env -p 'process.env.DEPLOYER_KEY')")" --ether --rpc-url "$ROBINHOOD_RPC_URL"
```

## 8. Broadcast

```sh
forge script contracts/script/DeployVayle.s.sol:DeployVayle --root contracts --rpc-url robinhood \
  --broadcast --slow \
  --verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
```

forge says `VayleMarket` is above the contract size limit and asks whether to continue. Answer yes, for the reason in step 6. `--non-interactive` answers it for you, which is what the local fork passes. `--slow` sends each transaction only once the one before it has confirmed.

The broadcast does this, in order:

1. Deploys the timelock with no delay and the deployer as its only proposer and executor, then the liveness checkpoint, the session calendar, the token registry, the price adapter and the market. The timelock owns the calendar, the registry and the market. The market starts with `GUARDIAN` as its guardian, `FEE_RECIPIENT` for fees, and the fee at zero.
2. Sends one batch through the timelock at no delay. If any call in it fails, the whole batch reverts, so nothing ends half configured. The batch:
   - lists NVDA in the registry, with its uid and feed from the chain facts and the grid from step 4
   - appends the boundaries to the calendar
   - sets the call caps and the put caps
   - flags `TEAM_MAKER` as team-operated, so every fill it makes is tagged onchain
   - approves `TEAM_MAKER` as a batch bidder
   - raises the timelock's delay to `TIMELOCK_DELAY`
3. Grants the timelock's proposer, canceller and executor roles to the multisig, and has the deployer renounce those three and the admin role. From then on the timelock administers itself, and only the multisig can propose or execute through it.

Then forge verifies the six contracts on the explorer, which step 9 covers.

forge should print `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`. `deployments/vayle-robinhood-mainnet.json` then holds `chainId`, `block`, and the `timelock`, `liveness`, `calendar`, `registry`, `priceAdapter` and `market` addresses. `block` is the block the script ran against, at or just before the deploy, and it's the start block for the watcher, the indexer and the app. It should sit just below the block numbers of the deploy's transactions on the explorer. Keep the file in the repo, since the fallback page builds from it.

Check the handover with the addresses from that file. Each comment is the answer to expect:

```sh
cast call <timelock> "getMinDelay()(uint256)" --rpc-url "$ROBINHOOD_RPC_URL"                                                      # TIMELOCK_DELAY
cast call <timelock> "hasRole(bytes32,address)(bool)" "$(cast keccak PROPOSER_ROLE)" <multisig> --rpc-url "$ROBINHOOD_RPC_URL"    # true
cast call <timelock> "hasRole(bytes32,address)(bool)" "$(cast keccak PROPOSER_ROLE)" <deployer> --rpc-url "$ROBINHOOD_RPC_URL"    # false
cast call <market> "owner()(address)" --rpc-url "$ROBINHOOD_RPC_URL"                                                              # the timelock
cast call <market> "batchBidder(address)(bool)" <team maker> --rpc-url "$ROBINHOOD_RPC_URL"                                       # true
cast call <calendar> "boundaryCount()(uint256)" --rpc-url "$ROBINHOOD_RPC_URL"                                                    # 10
```

The script writes the address file while it runs, before forge sends anything. So a broadcast that fails can leave a file naming contracts that don't exist. Open the market's address on the explorer before giving it to anything. If a broadcast stops partway, the contracts it did deploy hold nothing and nothing will use them. Generate the boundaries again and broadcast again, which deploys a fresh set and rewrites the file.

If the contracts deployed but verification didn't finish, forge ends with `Not all (n / 6) contracts were verified!` and exits non-zero. The deploy above that line still went through, so don't broadcast again. Verify in step 9.

## 9. Verify the contracts on Blockscout

The chain's explorer is Blockscout at `https://robinhoodchain.blockscout.com`, `chain.explorerUrl` in the chain facts. The broadcast's `--verify` flags verify every contract it deployed. If that didn't finish, verify each contract on its own:

```sh
forge verify-contract <address> <contract> --root contracts --rpc-url robinhood --chain 4663 \
  --guess-constructor-args --watch \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
```

| Address in the file | Contract                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `timelock`          | `lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController` |
| `liveness`          | `src/liveness/LivenessCheckpoint.sol:LivenessCheckpoint`                                    |
| `calendar`          | `src/calendar/SessionCalendar.sol:SessionCalendar`                                          |
| `registry`          | `src/assets/StockTokenRegistry.sol:StockTokenRegistry`                                      |
| `priceAdapter`      | `src/assets/PriceAdapter.sol:PriceAdapter`                                                  |
| `market`            | `src/VayleMarket.sol:VayleMarket`                                                           |

forge takes the compiler settings from `contracts/foundry.toml`: solc 0.8.37, the IR pipeline, 200 optimizer runs and the cancun EVM. `--guess-constructor-args` finds each contract's constructor arguments in its creation transaction.

Each contract's page, `https://robinhoodchain.blockscout.com/address/<address>`, should show its source as verified. The flags come from `forge verify-contract --help` in Foundry 1.7.1. forge sends its verification requests to the `--verifier-url`, here the explorer's `/api/` path, which is where Blockscout explorers serve their API. This explorer's API can answer command-line clients with a 403 challenge page instead of JSON. If that's what comes back, wait and run it again, or print the compiler input with `--show-standard-json-input` and submit it through the explorer's own verification page.

## 10. Create the database tables

The watcher and the indexer keep their state in one Supabase project. Create the tables from `supabase/migrations`:

```sh
supabase db push --db-url "<the project's Postgres connection string>" --dry-run
supabase db push --db-url "<the project's Postgres connection string>"
```

The first lists the two migrations it would apply, and the second applies them in order. The connection string is on the project's dashboard, with its password percent-encoded. The CLI leaves a `supabase/.temp` folder that git doesn't ignore, so delete it afterwards. Pasting each migration into the project's SQL editor, in file name order, does the same job.

The project should then have three tables, each with row level security on and no policies, so only the service role key can read or write them. `watcher_state` holds the watcher's cursor and active alerts. `market_events` and `indexer_state` hold the indexer's copy of the market's events and its cursor. The project's URL is `SUPABASE_URL` and its service role key is `SUPABASE_SERVICE_ROLE_KEY`, for both services.

## 11. Deploy the Workers

The keeper, the maker, the watcher and the indexer are Cloudflare Workers, each run by a cron every minute (`crons = ["* * * * *"]` in its `wrangler.toml`). They need Cloudflare's Workers paid plan, because a run makes more subrequests and uses more CPU time than the free plan allows, as [Cloudflare's limits page](https://developers.cloudflare.com/workers/platform/limits/) sets them out. [services/README.md](services/README.md) says what each one does.

The wrangler commands use the version the repo pins in `apps/web`, run from the repo root and pointed at a service with `--cwd`:

```sh
pnpm --filter @vayle/web exec wrangler login
pnpm --filter @vayle/web exec wrangler whoami
pnpm --filter @vayle/web exec wrangler deploy --cwd "$PWD/services/<service>"
pnpm --filter @vayle/web exec wrangler secret put <NAME> --cwd "$PWD/services/<service>"
pnpm --filter @vayle/web exec wrangler secret list --cwd "$PWD/services/<service>"
```

`whoami` shows the account wrangler deploys to. `secret put` asks for the value, and a secret stays in place across deploys. Vars go in a `[vars]` table in the service's `wrangler.toml`, with each value as a quoted string. Every deploy sets the Worker's vars from that table and drops any that aren't in it. Adding `--dry-run` to a deploy builds the Worker without uploading it.

Deploy a Worker first, then put its secrets. Until they're in, each run stops at `MissingSetting` and does nothing else.

### Watcher

Secrets: `ROBINHOOD_RPC_URL`, `WATCHER_WEBHOOK_URL` for where alerts are posted, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Vars, all five or none, or the run stops at `MarketConfigIncomplete`:

```toml
[vars]
VAYLE_MARKET = "<market from the address file>"
VAYLE_LIVENESS = "<liveness from the address file>"
VAYLE_CALENDAR = "<calendar from the address file>"
VAYLE_REGISTRY = "<registry from the address file>"
VAYLE_START_BLOCK = "<block from the address file>"
```

Without the vars it watches NVDA, USDG and the feed only, so it can go up before step 8, and the vars can follow the deploy. Once it runs, `watcher_state` has one row whose `cursor_block` moves forward every minute.

### Keeper

Secrets: `ROBINHOOD_RPC_URL` and `KEEPER_KEY`. Vars: `VAYLE_MARKET`, `VAYLE_LIVENESS` and `VAYLE_CALENDAR`, from the address file. Send the keeper's address ETH for gas, which is all it holds.

Have it running, with its secrets and its gas, more than 45 minutes before the first close. A week opens at a close only if the chain was checkpointed with no gap over 5 minutes through the 30 minutes before it, and an observation in its last 5 minutes found NVDA's oracle running (`GAP_THRESHOLD` in `contracts/src/liveness/LivenessCheckpoint.sol`, `LIVENESS_LOOKBACK` and `CLOSE_OBSERVATION_RECENCY` in `contracts/src/core/EpochBook.sol`). The liveness contract counts the time since its own deploy as quiet, so the first checkpoint records one long gap that ends where it lands. The keeper starts checkpointing 45 minutes before each close (`KEEPER_LEAD` in `services/keeper/src/plan.ts`), which puts the end of that gap before the 30 minutes that count. A keeper that starts inside them makes `createEpoch` revert `LivenessGapAtClose` or `CloseNotObserved`, and that week doesn't open. Orders stay idle and withdrawable, and the next week opens as usual once the keeper is running for its close. The keeper does nothing earlier than 45 minutes before a close, so deploying it right after the contracts is fine.

From 45 minutes before the close, `lastSeen` on the liveness contract should move every minute:

```sh
cast call <liveness> "lastSeen()(uint64)" --rpc-url "$ROBINHOOD_RPC_URL"
```

### Maker

Secrets: `ROBINHOOD_RPC_URL` and `MAKER_KEY`, the key whose address is `TEAM_MAKER`. Vars: `VAYLE_MARKET` and the pricing inputs `MAKER_VOL_BPS`, `MAKER_EDGE_BPS`, `MAKER_DIVIDEND_YIELD_BPS`, `MAKER_RATE_BPS`, `MAKER_MAX_PER_SERIES` and `MAKER_RFQ`, which [services/maker/README.md](services/maker/README.md) describes. The Worker reads vars and secrets the same way, so the pricing inputs can be secrets if you'd rather they weren't in the public repo.

Fund it before the first bid window. A week's bid window opens two hours after its close, the length of an exercise window, and stays open two hours (`WINDOW_LENGTH` in `contracts/src/core/EpochBook.sol`, `BID_WINDOW` in `contracts/src/core/RenewalBatch.sol`). Renewal bids are only taken inside it. The maker's account needs:

- USDG for the premiums it bids, plus the strike of every call it may buy, which it keeps back to exercise with. The protocol fee comes on top of premiums and starts at zero.
- NVDA for every put it may buy. It bids on puts only as far as it holds the NVDA to deliver.
- ETH for gas.

`MAKER_MAX_PER_SERIES` caps what it buys in one series, so it bounds both amounts per series. With less in its account, the maker bids less rather than buying options it couldn't exercise. Its first run approves the market to move its USDG and NVDA.

In the bid window the market should emit `BidSubmitted` for each price with orders, and the app's ladder shows the bids. If it doesn't bid, `pnpm --filter @vayle/web exec wrangler tail vayle-maker` shows why. A run that won't price logs `maker: no bids or quotes this run.` with the reason, and a failed action logs its error.

### Indexer

As a Worker, its secrets are `ROBINHOOD_RPC_URL`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and its vars are `VAYLE_MARKET` and `VAYLE_START_BLOCK`, the address file's `block`. The URL `wrangler deploy` prints serves its API.

It can run on a server as a Node process instead, with the same settings in that machine's `.env`, as [services/indexer/README.md](services/indexer/README.md) describes:

```sh
node --env-file=.env services/indexer/src/node.ts
```

Run one or the other. `curl <indexer URL>/v1/run` should return JSON whose `source.toBlock` grows from one minute to the next.

## 12. Open the site

The site at vayle.xyz is the Worker in `apps/web`, serving the Vite build as static assets. Until a build names a market, `/app/` says Vayle isn't open yet.

1. In `apps/web/wrangler.jsonc`, set `RPC_LOG_ADDRESSES` to the market's address. The site's `/rpc` answers `eth_getLogs` only for addresses on that list, and the app's history reads the market's logs. Check `RESTRICTED_COUNTRIES` and `RESTRICTED_REGIONS` while you're there. They're the places the app doesn't offer new orders.
2. Build with the market:

   ```sh
   VITE_RPC_URL=/rpc \
   VITE_MARKET=<market address> \
   VITE_MARKET_DEPLOY_BLOCK=<block from the address file> \
   VITE_INDEXER_URL=<indexer URL> \
   pnpm --filter @vayle/web build
   ```

   - `VITE_RPC_URL=/rpc` makes the page read the chain through the Worker's `/rpc`, which forwards to the `RPC_URL` secret, so the RPC's key never ships in the page.
   - `VITE_MARKET` turns the app on.
   - `VITE_MARKET_DEPLOY_BLOCK` is where the app starts reading the market's events from the chain when there's no indexer. It reads at most 500,000 blocks that way (`MAX_CHAIN_HISTORY_BLOCKS` in `apps/web/src/app/useMarketHistory.ts`), which is less than a day of this chain's blocks, so history needs the indexer soon after launch.
   - `VITE_INDEXER_URL` is the indexer's base URL.
   - `VITE_PLACEMENT` stays unset for now. New orders need a build with `VITE_PLACEMENT=open` and the disclosures published at `/disclosures.json`, as [apps/web/README.md](apps/web/README.md) describes. Settling, stopping an order and withdrawing never depend on it.
   - `VITE_WALLETCONNECT_PROJECT_ID` is optional. It turns on WalletConnect for phone wallets.

3. Deploy, and put the RPC secret if it isn't set yet:

   ```sh
   pnpm --filter @vayle/web exec wrangler deploy
   pnpm --filter @vayle/web exec wrangler secret put RPC_URL
   ```

   `RPC_URL` is the private RPC `/rpc` forwards to. It can be the same as `ROBINHOOD_RPC_URL`, and it needs the same 10,000-block log reads, because the app asks for history in ranges that size. The Worker takes `vayle.xyz` as its custom domain from `routes` in `wrangler.jsonc`, which needs the domain as a zone in the same Cloudflare account.

`https://vayle.xyz/app/market` should then list the same contract addresses as the address file.

## 13. Publish the fallback page

```sh
pnpm --filter @vayle/fallback build
```

The build takes the market's address from `deployments/vayle-robinhood-mainnet.json` and writes one file, `apps/fallback/dist/index.html`. Put it somewhere that doesn't depend on the site, so holders can reach the market through their own wallets when the site is down. Opened from disk with a wallet on Robinhood Chain, it should show the market's address and read the wallet's orders without an error. [apps/fallback/README.md](apps/fallback/README.md) has the rest.

## 14. Sweep the deployer key

The deploy key controls nothing now. Send what's left on it back, keeping enough for the transfer's own gas:

```sh
export DEPLOYER_KEY="$(node --env-file=.env -p 'process.env.DEPLOYER_KEY')"
cast balance "$(cast wallet address "$DEPLOYER_KEY")" --ether --rpc-url "$ROBINHOOD_RPC_URL"
cast send <the account that funded it> --value <amount>ether --private-key "$DEPLOYER_KEY" --rpc-url "$ROBINHOOD_RPC_URL"
```

If the send fails for lack of gas, send a little less. Then delete `DEPLOYER_KEY` from `.env` and close the shell, so the key doesn't stay in its environment either.

## 15. Watch the first week

All times are New York time, and the numbers come from the constants named above.

| When                              | What should happen                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 45 minutes before the first close | The keeper starts checkpointing the chain every minute.                                                                                                                                               |
| The last 30 minutes before it     | The keeper observes the close every minute.                                                                                                                                                           |
| Just after the close              | The keeper creates the first week's epoch, and the watcher posts `EpochCreated`. With no epoch 15 minutes after the close, it raises `epoch-missing`.                                                 |
| 2 hours after the close           | The bid window opens for 2 hours, and the maker bids on each price that has orders.                                                                                                                   |
| 4 hours after the close           | The keeper opens, counts and fills the batch for each price with a bid.                                                                                                                               |
| Sunday 8:00 PM                    | The batch deadline, 13 hours 30 minutes before the Monday 09:30 creation deadline (`BATCH_DEADLINE_LEAD` in `EpochBook.sol`). A batch not counted by then doesn't fill, and its orders skip the week. |

The watcher pages if the keeper stops checkpointing for more than 3 minutes from 45 minutes before a close to 2 hours 30 minutes after it.

## After launch

- The calendar holds the ten weeks from step 5. The watcher warns once fewer than five closes are scheduled ahead (`MIN_BOUNDARIES_AHEAD` in `services/watcher/src/rules.ts`). Adding more goes through the timelock and waits out its delay, so start when the warning comes. Generate the next closes after the last scheduled one with the step 5 command, starting from that close instead of from now, and have the multisig schedule the calendar's `append` with them through the timelock, then execute it after the delay. Each close still has to be more than a day after the block that executes it.
- Keep ETH on the keeper's and the maker's accounts, and keep the maker funded for the weeks ahead.
- Every owner power goes through the timelock, scheduled by the multisig and executed after the delay: caps, the fee, the guardian, the team-operated and batch bidder flags, the calendar, the registry's listings and renewing a halt.

## Checklist

What the owner provides:

- [ ] A private Robinhood Chain mainnet RPC with archive state, `eth_getLogs` over 10,000 blocks and `eth_feeHistory`. It's `ROBINHOOD_RPC_URL`, and the site's `RPC_URL`, which can be the same one.
- [ ] ETH on Robinhood Chain for the deployer, a few times the dry run's estimate, and for the keeper's and the maker's gas.
- [ ] The multisig, `MULTISIG`.
- [ ] The guardian key, held apart from the rest, with its address as `GUARDIAN`.
- [ ] `FEE_RECIPIENT`.
- [ ] `TIMELOCK_DELAY`, `CALL_CAPS` and `PUT_CAPS`.
- [ ] The keeper key and the maker key, `KEEPER_KEY` and `MAKER_KEY`, with the maker's address as `TEAM_MAKER`.
- [ ] The maker's USDG and NVDA, and its pricing inputs.
- [ ] A Supabase project: its Postgres connection string, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- [ ] A webhook for the watcher's alerts, `WATCHER_WEBHOOK_URL`.
- [ ] A Cloudflare account on the Workers paid plan, with vayle.xyz as a zone in it.
- [ ] A server for the indexer, if it doesn't run as a Worker, and a WalletConnect project ID, if phone wallets should connect.
- [ ] Before new orders open: the disclosures at `/disclosures.json`, and the restricted countries and regions.
