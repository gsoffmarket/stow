-- Mini App sessions belong to a Telegram account, not to one workspace: a
-- person may be a member of several. Each request still checks membership.
create table miniapp_sessions (
  id uuid primary key default uuidv7(),
  telegram_user_id text not null check (telegram_user_id ~ '^[0-9]{1,20}$'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index miniapp_sessions_user on miniapp_sessions (telegram_user_id);
