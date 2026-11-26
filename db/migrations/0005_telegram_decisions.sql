-- A preview the coordinator confirms with a button. It carries the exact
-- command, bound to the order version it was previewed against, so a confirm
-- after the order changed is refused instead of applied to a different state.
create table telegram_actions (
  workspace_id uuid not null,
  id uuid not null default uuidv7(),
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{16}$'),
  member_id uuid not null,
  chat_id text not null,
  command jsonb not null,
  summary text not null check (length(summary) between 1 and 4000),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id),
  foreign key (workspace_id, member_id) references members (workspace_id, id)
);

-- Exception messages are delivered from the outbox like status messages.
alter table telegram_outbox drop constraint telegram_outbox_kind_check;
alter table telegram_outbox add constraint telegram_outbox_kind_check check (kind in ('STATUS', 'REPLY', 'EXCEPTION'));
alter table telegram_message_refs drop constraint telegram_message_refs_purpose_check;
alter table telegram_message_refs add constraint telegram_message_refs_purpose_check check (purpose in ('STATUS', 'EXCEPTION'));
-- Which exception an EXCEPTION message is about; a new report gets a new message.
alter table telegram_message_refs add column exception_id uuid;
