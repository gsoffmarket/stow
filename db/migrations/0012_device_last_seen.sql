-- When a pair of glasses last reached the API, for the Sessions page. It is
-- written at most every 30 seconds per device, not on every 1.5-second poll,
-- so presence costs a few writes a minute per connected picker.
alter table device_tokens add column last_seen_at timestamptz;
