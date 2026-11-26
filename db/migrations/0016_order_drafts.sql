-- An /order whose items do not each name one product: unknown, or an alias
-- several products share. It is kept as a draft that no one can pick until a
-- coordinator chooses the products and confirms it; confirming creates the
-- order with the draft's source key, so its status message reaches the
-- group as if the order had been typed correctly.
create table order_drafts (
  workspace_id uuid not null references workspaces (id),
  id uuid not null default uuidv7(),
  ref text check (length(ref) between 1 and 40),
  source_key text not null check (length(source_key) <= 200),
  connection_id uuid,
  source_message_id text check (source_message_id ~ '^[0-9]{1,20}$'),
  created_by uuid not null,
  -- [{item, quantity, sku, candidates}]: sku is null until the line names one product.
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 100),
  status text not null default 'OPEN' check (status in ('OPEN', 'CONFIRMED', 'DISCARDED')),
  order_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  primary key (id),
  unique (workspace_id, source_key),
  foreign key (workspace_id, created_by) references members (workspace_id, id),
  foreign key (workspace_id, order_id) references orders (workspace_id, id),
  foreign key (workspace_id, connection_id) references telegram_connections (workspace_id, id),
  check ((status = 'CONFIRMED') = (order_id is not null))
);

create index order_drafts_open on order_drafts (workspace_id, created_at) where status = 'OPEN';
