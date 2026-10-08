# Watcher

A Cloudflare Worker that checks the chain every minute and posts an alert when something needs a person: an issuer pauses a market's token, its access registry or USDG, a token's oracle pauses, a corporate action is pending, a feed goes quiet in the trading week, the keeper goes silent near a close, a week's epoch hasn't opened, a market's listing or caps aren't the markets file's, the session calendar is running out, or the owner or the guardian acts on the market, its calendar or its listing. It never sends transactions and holds no key.

It watches every market in `deployments/markets.json`, and its rules run for each one.

## What it alerts on

Conditions, checked every run, where `<symbol>` is a market's symbol in lower case:

| Alert                                     | When                                                                                                                                         | Severity                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `issuer-paused:<symbol>`                  | The market's token is paused                                                                                                                 | page                                             |
| `issuer-paused:access-registry:<address>` | An access registry the tokens name is paused, once for every token that names it                                                             | page                                             |
| `issuer-paused:usdg`                      | USDG is paused                                                                                                                               | page                                             |
| `oracle-paused:<symbol>`                  | The token's `oraclePaused()` is true                                                                                                         | page                                             |
| `multiplier-pending:<symbol>`             | The token has a multiplier change scheduled                                                                                                  | warn                                             |
| `feed-stale:<symbol>`                     | The market's feed's latest round is older than its heartbeat in the markets file plus an hour, from Sunday 21:00 ET to Friday 20:00 ET       | warn                                             |
| `keeper-silent`                           | No liveness checkpoint for more than 3 minutes, from 45 minutes before a close to 2 hours 30 minutes after it                                | page                                             |
| `epoch-missing:<symbol>`                  | No epoch for the market 15 minutes after a close, until its creation deadline                                                                | warn, then page from 6 hours before the deadline |
| `first-epoch-missing:<symbol>`            | Before the schedule's first close, the market's first week still hasn't opened an hour after it could, `deployedAt` plus `LIVENESS_LOOKBACK` | page                                             |
| `caps-differ:<symbol>`                    | A cap the market holds for the asset isn't the one the markets file sets, naming each                                                        | warn                                             |
| `listing-differs:<symbol>`                | The market's listing in the token registry isn't the markets file's, naming each field, or the registry doesn't list it                      | page                                             |
| `market-unreadable:<symbol>`              | The market's token, feed or access registry refused a read this run                                                                          | page                                             |
| `calendar-runway`                         | Fewer than 5 closes scheduled ahead                                                                                                          | warn                                             |
| `halt-active`                             | An emergency halt is on                                                                                                                      | page                                             |
| `market-paused`                           | New orders are paused market-wide                                                                                                            | warn                                             |
| `market-paused:<symbol>`                  | New orders are paused for the market                                                                                                         | warn                                             |

The thresholds are constants in `src/rules.ts`. The feed's session starts at 20:00 ET on Sunday, and the first hour of it doesn't count, so a feed that resumes a little late isn't stale. A market with `listing-differs` or `market-unreadable` raises that alone: nothing else about it is checked until it clears, and the keeper and the maker leave it alone too. One bad market never stops the others' alerts.

These events from the market, the liveness contract, the calendar and the registry alert once each, with a link to their transaction on the explorer:

- page: `HaltStarted`, `HaltExtended`, `HaltEnded`, `OraclePauseObserved` and `PauseObserved`
- warn: `GapRecorded`, `PausedSet`, `AssetPausedSet`, `GuardianSet`, `CapsSet`, `FeeSet`, `TeamOperatedSet`, `BatchBidderSet`, `OwnershipTransferStarted` and `OwnershipTransferred`
- info: `PauseEnded`, `BoundariesAppended`, `BoundariesTruncated`, `AssetListed`, `AssetDelisted`, `EpochCreated`, `BatchDone`, and `QuoteFilled` by a maker that isn't flagged team-operated

It doesn't read the timelock, so a change the multisig schedules alerts when it executes, as one of the events above, not when it's scheduled.

A condition alerts once when it starts, again if it escalates from warn to page, every hour while it pages, and once when it clears. If posting fails, the run fails and the next one retries from the same cursor, so delivery is at least once. Five failed runs in a row page on their own, with the last error's text (`FAILURES_BEFORE_PAGE` in `src/run.ts`).

## Where alerts go

Every run's alerts go to `WATCHER_WEBHOOK_URL` in one POST, pages first, one line each.

- A Discord webhook, a URL on `discord.com` or `discordapp.com` whose path starts with `/api/webhooks/`, gets Discord's shape: `{ "content": "<the lines>" }`. Discord takes at most 2,000 characters, so the lines are kept whole while they fit and the rest are counted in a last line, `…and N more` (`DISCORD_LIMIT` in `src/sink.ts`).
- Any other URL gets `{ "text": "<the lines>", "alerts": [...] }`, where `alerts` lists each alert's key, severity and text.

## How it reads

The client comes from `watcherClient` in `src/clients.ts`, on `robinhoodChain` from `@vayle/chain-facts/chain`, with reads batched through Multicall3 at up to 32 KiB of calldata per call (`MULTICALL_BYTES`). Every read is pinned to the latest block. Every market's reads go out together in one call: its token's pause, oracle flag, multipliers and access registry, its feed's latest round, USDG's pause, and with the market configured, its asset pause, latest epoch, caps and listing in the token registry, and the market's `lastSeen`, pause, halt, `deployedAt`, `LIVENESS_LOOKBACK` and the calendar's boundary count. A second call reads each access registry the tokens name, once, and the calendar 64 boundaries at a time, newest first (`BOUNDARY_WINDOW` in `src/snapshot.ts`). Logs come in chunks of 5,000 blocks, at most four a run (`MAX_RANGE` and `MAX_CHUNKS` in `src/run.ts`), so a backlog drains over several runs. A run is a handful of RPC requests whatever the number of markets: 3 for the state, one market or two (`test/reads.test.ts` pins it), plus one per chunk of logs.

A read a market's own token, feed or access registry refuses is pinned on that market alone. A request that fails takes every market's reads with it and fails the run. Errors are logged without the RPC's URL, through `errorText` and `redacted` from `@vayle/chain-facts/rpc-errors`, and the failure alert's text is cut the same way.

## Configuration

Secrets, set with `wrangler secret put`:

- `ROBINHOOD_RPC_URL`: the private Robinhood Chain RPC the other services use.
- `WATCHER_WEBHOOK_URL`: where alerts are posted, a Discord webhook or any URL that takes the JSON above.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: the project holding the `watcher_state` table from `supabase/migrations`, one row with the log cursor, the conditions alerting and the count of failed runs.

Vars, set once the contracts are deployed, all together or not at all: `VAYLE_MARKET`, `VAYLE_LIVENESS`, `VAYLE_CALENDAR`, `VAYLE_REGISTRY` and `VAYLE_START_BLOCK`. Some but not all stops the run with `MarketConfigIncomplete`. Without them the watcher covers each market's token, access registry and feed, and USDG, only. The markets come from `deployments/markets.json`, and USDG and the explorer from `deployments/robinhood-mainnet.json`, both built into the Worker.

## Development

```sh
pnpm --filter @vayle/watcher test
```

The rules are pure functions of a chain snapshot and decoded logs, so the tests need no network. The reads run against a JSON-RPC endpoint in memory.
