-- Every event the market emits, decoded, and the indexer's cursor. Row level security is on with
-- no policies, so only the indexer Worker's service key reads or writes them. Order and series IDs
-- are decimal text: series IDs are 256-bit, and JSON numbers would round them.
create table if not exists public.market_events (
  block_number bigint not null,
  log_index integer not null,
  tx_hash text not null,
  block_time timestamptz not null,
  name text not null,
  order_id text,
  series text,
  account text,
  args jsonb not null,
  primary key (block_number, log_index)
);

create index if not exists market_events_order_id on public.market_events (order_id);
create index if not exists market_events_series on public.market_events (series);
create index if not exists market_events_account on public.market_events (account);
create index if not exists market_events_name on public.market_events (name);

create table if not exists public.indexer_state (
  id text primary key,
  cursor_block bigint not null
);

alter table public.market_events enable row level security;
alter table public.indexer_state enable row level security;
