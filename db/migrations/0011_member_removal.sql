-- Removing someone keeps their row, because events, orders and notes name
-- them, but ends their access: the Telegram link is cleared (which is how
-- sign-in finds a membership) and their devices are revoked alongside.
alter table members add column removed_at timestamptz;
alter table members add constraint members_removed_unlinked check (removed_at is null or telegram_user_id is null);
