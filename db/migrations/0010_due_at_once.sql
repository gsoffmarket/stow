-- A new inbox or outbox row is due at once. Stamping it with now() made it
-- wait whenever the server clock stepped backwards after the insert (steps of
-- 200 ms were measured on a Docker VM), so the next delivery pass skipped a
-- fresh row. Only retries and leases need a real time.
alter table telegram_inbox alter column next_attempt_at set default '-infinity';
alter table telegram_outbox alter column next_attempt_at set default '-infinity';
