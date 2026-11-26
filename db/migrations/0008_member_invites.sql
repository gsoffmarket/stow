-- One-time links that let an owner add people. The link carries a random
-- token; only its hash is stored. Opening it in Telegram creates the member
-- with the invited role and links their Telegram account.
create table member_invites (
  workspace_id uuid not null references workspaces (id),
  id uuid not null default uuidv7(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  role text not null check (role in ('COORDINATOR', 'PICKER')),
  created_by uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id),
  foreign key (workspace_id, created_by) references members (workspace_id, id)
);
