-- Pairing a pair of glasses without typing anything on them. The glasses show
-- a short code and keep a private polling secret; a picker signed in to the
-- Mini App approves the code; the glasses exchange the approval once for a
-- device token. Only hashes of the code and secret are stored.
create table device_pairings (
  id uuid primary key default uuidv7(),
  label text not null check (length(label) between 1 and 60),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'CONSUMED')),
  workspace_id uuid references workspaces (id),
  member_id uuid,
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, member_id) references members (workspace_id, id),
  check ((status = 'PENDING') = (member_id is null))
);
