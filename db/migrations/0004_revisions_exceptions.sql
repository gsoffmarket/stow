-- Every revision is kept: what the targets were, what they became, and why.
-- Picked counts are not part of a revision; they only change through events.
create table order_revisions (
  workspace_id uuid not null,
  order_id uuid not null,
  revision integer not null check (revision >= 2),
  reason text not null check (length(reason) between 1 and 280),
  actor_member_id uuid not null,
  prior_targets jsonb not null,
  new_targets jsonb not null,
  created_at timestamptz not null default now(),
  primary key (order_id, revision),
  foreign key (workspace_id, order_id) references orders (workspace_id, id),
  foreign key (workspace_id, actor_member_id) references members (workspace_id, id)
);

create table order_exceptions (
  workspace_id uuid not null,
  id uuid not null,
  order_id uuid not null,
  line_id uuid,
  type text not null check (type in ('SHORTAGE', 'DAMAGED', 'LOCATION_MISMATCH', 'RETURN_BLOCKED', 'OTHER')),
  reported_qty integer check (reported_qty between 0 and 10000),
  status text not null check (status in ('OPEN', 'RESOLVED_AWAITING_ACK', 'CLOSED')),
  reporter_id uuid not null,
  reported_revision integer not null,
  resolution text check (resolution in ('RESUME', 'REDUCE', 'SUBSTITUTE', 'CANCEL')),
  resolution_reason text check (length(resolution_reason) between 1 and 280),
  resolver_id uuid,
  resolved_at timestamptz,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id),
  foreign key (workspace_id, order_id) references orders (workspace_id, id),
  foreign key (workspace_id, line_id) references order_lines (workspace_id, id),
  foreign key (workspace_id, reporter_id) references members (workspace_id, id),
  foreign key (workspace_id, resolver_id) references members (workspace_id, id)
);
-- At most one unresolved exception per order.
create unique index order_exceptions_one_active on order_exceptions (order_id) where status <> 'CLOSED';
