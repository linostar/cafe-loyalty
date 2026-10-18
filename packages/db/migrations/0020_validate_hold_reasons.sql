-- migration: expand
-- Checks the existing sync_events rows against 0018's hold reasons, in a transaction of its own: VALIDATE CONSTRAINT
-- takes a lock that lets the running release keep reading and writing while it scans. Runs as cl_owner with
-- search_path = app.
ALTER TABLE sync_events VALIDATE CONSTRAINT sync_events_hold_reason_check;
