#!/bin/sh
# Runs forge test with every fork test on one recent block, so forge's RPC cache serves repeated
# reads for the whole run. This chain makes about four blocks a second, so without a pinned block
# each test would fork a block of its own. Takes forge test's own arguments. ROBINHOOD_RPC_URL
# comes from the environment or the repo's .env, and FORK_BLOCK, if set, wins.
set -eu
cd "$(dirname "$0")"
if [ -z "${ROBINHOOD_RPC_URL:-}" ] && [ -f ../.env ]; then
  ROBINHOOD_RPC_URL="$(grep '^ROBINHOOD_RPC_URL=' ../.env | head -n 1 | cut -d= -f2-)"
fi
export ROBINHOOD_RPC_URL
FORK_BLOCK="${FORK_BLOCK:-$(cast block-number --rpc-url "$ROBINHOOD_RPC_URL")}"
export FORK_BLOCK
exec forge test "$@"
