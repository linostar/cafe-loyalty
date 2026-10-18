-- migration: expand
-- Three more reasons a visit is held for the owner instead of applied: more stamps than the program's reward needs
-- (large_visit), more than the device's daily cap applied on the café day the server received them (daily_cap_received:
-- the visit's own time is the device's to set, so the cap by that day alone could be passed by backdating), and a time
-- before the key that signed it was made (before_key). Added NOT VALID, so the swap holds sync_events' lock only for an
-- instant instead of scanning it while the running release syncs; 0020 validates the existing rows under a lock that
-- lets reads and writes go on. Runs as cl_owner with search_path = app.
ALTER TABLE sync_events
  DROP CONSTRAINT sync_events_hold_reason_check,
  ADD CONSTRAINT sync_events_hold_reason_check
    CHECK (hold_reason IN ('device_revoked', 'staff_revoked', 'late_sync', 'campaign_check', 'large_visit', 'daily_cap_received', 'before_key')) NOT VALID;
