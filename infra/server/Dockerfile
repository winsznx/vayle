# The indexer, the watcher and the RPC relay as long-running Node processes, for a server. One image
# runs all three, each with its own command in compose.yaml.
FROM node:24-slim

# The relay sends each RPC request with curl.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /vayle
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .nvmrc ./
COPY deployments ./deployments
COPY packages ./packages
COPY services/indexer ./services/indexer
COPY services/watcher ./services/watcher
COPY tools/rpc-relay ./tools/rpc-relay

RUN pnpm install --frozen-lockfile --prod=false \
    --filter "@vayle/indexer..." --filter "@vayle/watcher..." --filter "@vayle/rpc-relay..."

USER node
