-- One-time codes that bind a Telegram group to a workspace. The member who
-- created the code is the one whose Telegram identity gets linked when the
-- code is sent in the group. Only the SHA-256 of a code is stored.
create table telegram_bind_challenges (
  workspace_id uuid not null,
  id uuid not null default uuidv7(),
  member_id uuid not null,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id),
  foreign key (workspace_id, member_id) references members (workspace_id, id)
);

-- The Telegram message an order came from, so its status message can reply to it.
alter table orders add column source_message_id text check (source_message_id ~ '^[0-9]{1,20}$');
