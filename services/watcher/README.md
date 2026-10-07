# Watcher

A Cloudflare Worker that checks the chain every minute and posts an alert when something needs a person: an issuer pauses NVDA, USDG or the NVDA oracle, a corporate action is pending, the NVDA feed goes quiet in the trading week, the keeper goes silent near a close, a week's epoch hasn't opened, the session calendar is running out, or the owner or the guardian acts on the market, its calendar or its listing. It never sends transactions and holds no key.

## What it alerts on

Conditions, checked every run:

| Alert                     | When                                                                                                          | Severity                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `issuer-paused:*`         | NVDA, the Stock Tokens' access registry or USDG is paused                                                     | page                                             |
| `oracle-paused:nvda`      | NVDA's `oraclePaused()` is true                                                                               | page                                             |
| `multiplier-pending:nvda` | NVDA has a multiplier change scheduled                                                                        | warn                                             |
| `feed-stale:nvda`         | The feed's latest round is more than 25 hours old, from Sunday 21:00 ET to Friday 20:00 ET                    | warn                                             |
| `keeper-silent`           | No liveness checkpoint for more than 3 minutes, from 45 minutes before a close to 2 hours 30 minutes after it | page                                             |
| `epoch-missing:nvda`      | No epoch 15 minutes after a close, until its creation deadline                                                | warn, then page from 6 hours before the deadline |
| `calendar-runway`         | Fewer than 5 closes scheduled ahead                                                                           | warn                                             |
| `halt-active`             | An emergency halt is on                                                                                       | page                                             |
| `market-paused`           | New orders are paused, market-wide or for NVDA                                                                | warn                                             |

The thresholds are constants in `src/rules.ts`. The feed's session starts at 20:00 ET on Sunday, and the first hour of it doesn't count, so a feed that resumes a little late isn't stale.

These events from the market, the liveness contract, the calendar and the registry alert once each, with a link to their transaction on the explorer:

- page: `HaltStarted`, `HaltExtended`, `HaltEnded`, `OraclePauseObserved` and `PauseObserved`
- warn: `GapRecorded`, `PausedSet`, `AssetPausedSet`, `GuardianSet`, `CapsSet`, `FeeSet`, `TeamOperatedSet`, `OwnershipTransferStarted` and `OwnershipTransferred`
- info: `PauseEnded`, `BoundariesAppended`, `BoundariesTruncated`, `AssetListed`, `AssetDelisted`, `EpochCreated`, `BatchDone`, and `QuoteFilled` by a maker that isn't flagged team-operated

It doesn't read the timelock, so a change the multisig schedules alerts when it executes, as one of the events above, not when it's scheduled. It doesn't alert on `BatchBidderSet`.

A condition alerts once when it starts, again if it escalates from warn to page, every hour while it pages, and once when it clears. If posting fails, the run fails and the next one retries from the same cursor, so delivery is at least once. Five failed runs in a row page on their own, with the last error's text (`FAILURES_BEFORE_PAGE` in `src/run.ts`).

## How it reads

The client is built on `robinhoodChain` from `@vayle/chain-facts/chain`, with reads batched through Multicall3 at up to 32 KiB of calldata per call (`MULTICALL_BYTES` in `src/worker.ts`). Every read is pinned to the latest block. The issuer's reads and the market's start together and go out as one call: NVDA's pause, oracle flag and multipliers, the access registry's and USDG's pause, the feed's latest round, and with the market configured, the liveness contract's `lastSeen`, the market's pauses, halt and latest epoch, and the calendar's boundary count. The calendar is then read 64 boundaries per call, newest first (`BOUNDARY_WINDOW` in `src/snapshot.ts`). Logs come in chunks of 5,000 blocks, at most four a run (`MAX_RANGE` and `MAX_CHUNKS` in `src/run.ts`), so a backlog drains over several runs. A run is a handful of RPC requests.

Errors are logged without the RPC's URL, through `errorText` and `redacted` from `@vayle/chain-facts/rpc-errors`, and the failure alert's text is cut the same way.

## Configuration

Secrets, set with `wrangler secret put`:

- `ROBINHOOD_RPC_URL`: the private Robinhood Chain RPC the other services use.
- `WATCHER_WEBHOOK_URL`: where alerts are posted, as JSON whose `text` carries the message and whose `alerts` list each alert's key, severity and text.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: the project holding the `watcher_state` table from `supabase/migrations`, one row with the log cursor, the conditions alerting and the count of failed runs.

Vars, set once the contracts are deployed, all together or not at all: `VAYLE_MARKET`, `VAYLE_LIVENESS`, `VAYLE_CALENDAR`, `VAYLE_REGISTRY` and `VAYLE_START_BLOCK`. Some but not all stops the run with `MarketConfigIncomplete`. Without them the watcher covers NVDA, USDG and the feed only. NVDA, its access registry, USDG, the feed and the explorer come from `deployments/robinhood-mainnet.json`, built into the Worker.

## Development

```sh
pnpm --filter @vayle/watcher test
```

The rules are pure functions of a chain snapshot and decoded logs, so the tests need no network.
