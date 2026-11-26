-- Human order refs (ST-1001, ST-1002, ...) come from a per-workspace counter
-- so they are short, unique and never reused, without exposing row IDs.
alter table workspaces add column order_seq bigint not null default 1000 check (order_seq >= 1000);

-- The chat an order came from, so its status message goes back there.
alter table orders add column connection_id uuid;
alter table orders add foreign key (workspace_id, connection_id) references telegram_connections (workspace_id, id);
