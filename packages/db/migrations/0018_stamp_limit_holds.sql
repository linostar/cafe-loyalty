-- migration: expand
-- Three more reasons a visit is held for the owner instead of applied: more stamps than the program's reward needs
-- (large_visit), more than the device's daily cap applied on the café day the server received them (daily_cap_received:
-- the visit's own time is the device's to set, so the cap by that day alone could be passed by backdating), and a time
-- before the key that signed it was made (before_key). Runs as cl_owner with search_path = app.
ALTER TABLE sync_events
  DROP CONSTRAINT sync_events_hold_reason_check,
  ADD CONSTRAINT sync_events_hold_reason_check
    CHECK (hold_reason IN ('device_revoked', 'staff_revoked', 'late_sync', 'campaign_check', 'large_visit', 'daily_cap_received', 'before_key'));

-- The device's stamps by the day they were received, as visits_device_day_idx serves the day they happened.
CREATE INDEX visits_device_received_idx ON visits (cafe_id, device_id, created_at) WHERE stamps_added > 0;
