-- Short messages attached to an order: coordinator notes shown on the glasses,
-- and picker replies posted to the work group. They never change the order:
-- a note saying "only send 2" is not a revision.
create table order_messages (
  workspace_id uuid not null,
  id uuid not null default uuidv7(),
  order_id uuid not null,
  direction text not null check (direction in ('TO_PICKER', 'TO_GROUP')),
  author_member_id uuid not null,
  body text not null check (length(body) between 1 and 280),
  -- For picker replies: the device's ID for this send, so a retry posts once.
  client_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (workspace_id, id),
  unique (author_member_id, client_id),
  foreign key (workspace_id, order_id) references orders (workspace_id, id),
  foreign key (workspace_id, author_member_id) references members (workspace_id, id)
);
create index order_messages_order on order_messages (order_id, created_at);
