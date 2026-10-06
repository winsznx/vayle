-- One row of watcher state: the last processed block and the conditions currently alerting.
-- Row level security is on with no policies, so only the service role can read or write it.
create table if not exists public.watcher_state (
  id text primary key,
  cursor_block bigint,
  active jsonb not null default '{}'::jsonb,
  failures integer not null default 0
);

alter table public.watcher_state enable row level security;
