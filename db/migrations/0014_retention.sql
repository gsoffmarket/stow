-- How long a workspace keeps closed orders, chosen by its owner: 90 or 365
-- days, or null to keep them until the workspace is deleted. Open orders are
-- never purged, whatever their age.
alter table workspaces add column retention_days integer check (retention_days in (90, 365));

-- The purge finds closed orders by when they closed; terminal orders do not
-- change after closing, so updated_at is that moment.
create index orders_closed on orders (workspace_id, updated_at) where terminal is not null;
