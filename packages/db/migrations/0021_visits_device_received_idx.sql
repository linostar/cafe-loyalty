-- migration: expand
-- transaction: none
-- The device's stamps by the day they were received (stampLimitHold), as visits_device_day_idx serves the day they
-- happened. Built CONCURRENTLY, outside a transaction, so the running release's syncs keep writing visits meanwhile; a
-- build that failed leaves an invalid index behind, which the DROP clears when the migration runs again. Runs as
-- cl_owner with search_path = app.
DROP INDEX CONCURRENTLY IF EXISTS visits_device_received_idx;
CREATE INDEX CONCURRENTLY visits_device_received_idx ON visits (cafe_id, device_id, created_at) WHERE stamps_added > 0;
