-- migration: expand
-- Counter sync (plan Step 8): the ledger of synced events, which makes every event count once (AC 24) and holds
-- events from revoked devices or staff for the owner's review (AC 21), and device keys that pairing again retires or
-- revoking the device revokes.
-- Runs as cl_owner with search_path = app.

-- Only a device's newest key renews its token (retired_at null; pairing again retires the others). Revoking the
-- device marks every key it had then, so events those keys signed are held for review even after it is paired again.
ALTER TABLE device_keys
  ADD COLUMN retired_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT device_keys_cafe_id_id_key UNIQUE (cafe_id, id);

CREATE UNIQUE INDEX device_keys_newest_key ON device_keys (cafe_id, device_id) WHERE retired_at IS NULL;

-- Every verified event a device synced, without its payload (stamps from visits arrive with plan Step 9). The café
-- and device come from the device's access token, never from the event (AC 25).
CREATE TABLE sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  device_id uuid NOT NULL,
  event_id uuid NOT NULL,
  -- SHA-256 of the signed bytes (syncEventSigningPayload): the same id sent again with other content is a conflict.
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  key_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 64),
  schema_version integer NOT NULL CHECK (schema_version >= 1),
  sequence integer NOT NULL CHECK (sequence >= 0),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('applied', 'held', 'discarded')),
  -- Set when the event was held; kept once the owner accepts (applied) or discards it.
  hold_reason text CHECK (hold_reason IN ('device_revoked', 'staff_revoked')),
  reviewed_at timestamptz,
  reviewed_by uuid,
  CONSTRAINT sync_events_event_key UNIQUE (cafe_id, device_id, event_id),
  CONSTRAINT sync_events_device_fkey FOREIGN KEY (cafe_id, device_id) REFERENCES devices (cafe_id, id),
  CONSTRAINT sync_events_key_fkey FOREIGN KEY (cafe_id, key_id) REFERENCES device_keys (cafe_id, id),
  CONSTRAINT sync_events_staff_fkey FOREIGN KEY (cafe_id, staff_id) REFERENCES staff (cafe_id, id),
  CONSTRAINT sync_events_reviewer_fkey FOREIGN KEY (cafe_id, reviewed_by) REFERENCES owners (cafe_id, id),
  -- Applied directly; or held, then accepted (applied) or discarded by an owner, who is recorded.
  CONSTRAINT sync_events_review_check CHECK (
    (hold_reason IS NULL AND status = 'applied' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (hold_reason IS NOT NULL AND status = 'held' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (hold_reason IS NOT NULL AND status IN ('applied', 'discarded') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  )
);

-- The owner's review queue, oldest first.
CREATE INDEX sync_events_held_idx ON sync_events (cafe_id, received_at, id) WHERE status = 'held';

ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON sync_events TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- Runtime privileges. The ledger is never deleted from; only a held event's review decision is written later.
GRANT SELECT, INSERT ON sync_events TO cl_app;
GRANT UPDATE (status, reviewed_at, reviewed_by) ON sync_events TO cl_app;
GRANT UPDATE (retired_at, revoked_at) ON device_keys TO cl_app;
-- Pairing a device again takes the name the owner gave its new pairing code.
GRANT UPDATE (name) ON devices TO cl_app;
