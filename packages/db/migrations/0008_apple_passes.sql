-- migration: expand
-- Apple Wallet passes (plan Step 10): one pass per card and epoch, and the devices registered for its updates, for
-- the PassKit web service (AC 11) and the worker's push notifications (AC 12, 13).
--
-- A pass is a card's at one epoch. Recovery gives the card a new epoch, and with it a new pass on the new phone; the
-- old pass stays, so the old phone can still fetch it and gets it voided (AC 8). Deleting the card deletes its passes
-- and their registrations (AC 9).
--
-- The PassKit web service finds a pass by the authenticationToken the device sends (its SHA-256 hash) and a device's
-- passes by its device library identifier (likewise hashed), both through current_secret_hash() (withLookup).
-- Runs as cl_owner with search_path = app.

CREATE TABLE apple_passes (
  -- The pass's serial number.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  card_id uuid NOT NULL,
  -- The card's epoch the pass was issued at; a pass of an earlier epoch is served voided.
  epoch integer NOT NULL CHECK (epoch >= 1),
  -- SHA-256 of the pass's authenticationToken (AC 11).
  auth_token_hash bytea NOT NULL CHECK (octet_length(auth_token_hash) = 32),
  -- The layout the device last received (AC 12), so a later layout can be pushed to the passes that lack it.
  layout_version integer NOT NULL CHECK (layout_version >= 1),
  -- The transaction that last changed the pass, a 64-bit counter that only grows: the web service's lastUpdated
  -- tags (AC 11). Unlike a sequence value it tells which changes may still be uncommitted (pg_snapshot_xmin), so a
  -- device never skips a change that commits after a later one.
  updated_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  -- Last-Modified of the pass (If-Modified-Since, AC 11), in whole seconds: each change moves it on by at least a
  -- second, so two changes within one second still differ.
  modified_at timestamptz NOT NULL DEFAULT date_trunc('second', now()),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apple_passes_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT apple_passes_card_epoch_key UNIQUE (card_id, epoch),
  CONSTRAINT apple_passes_auth_token_hash_key UNIQUE (auth_token_hash),
  CONSTRAINT apple_passes_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE CASCADE
);

-- A device that added the pass and asked for its updates. The push token is the device's APNs token for passes.
CREATE TABLE apple_pass_registrations (
  cafe_id uuid NOT NULL,
  pass_id uuid NOT NULL,
  -- SHA-256 of the device library identifier.
  device_library_hash bytea NOT NULL CHECK (octet_length(device_library_hash) = 32),
  push_token text NOT NULL CHECK (push_token ~ '^[0-9a-f]{16,256}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pass_id, device_library_hash),
  CONSTRAINT apple_pass_registrations_pass_fkey FOREIGN KEY (cafe_id, pass_id) REFERENCES apple_passes (cafe_id, id) ON DELETE CASCADE
);

CREATE INDEX apple_pass_registrations_device_idx ON apple_pass_registrations (device_library_hash);

CREATE TRIGGER apple_pass_registrations_touch_updated_at BEFORE UPDATE ON apple_pass_registrations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE apple_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE apple_passes FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON apple_passes TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY pass_by_token ON apple_passes FOR SELECT TO cl_app
  USING (auth_token_hash = current_secret_hash());
-- A device's own passes, through its registrations (which the policy below limits to the device's hash).
CREATE POLICY pass_through_registration ON apple_passes FOR SELECT TO cl_app
  USING (EXISTS (SELECT 1 FROM apple_pass_registrations WHERE apple_pass_registrations.pass_id = apple_passes.id));

ALTER TABLE apple_pass_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE apple_pass_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON apple_pass_registrations TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY registration_by_device ON apple_pass_registrations FOR SELECT TO cl_app
  USING (device_library_hash = current_secret_hash());

-- Runtime privileges. Passes go with their card (the foreign key's cascade); registrations end when the device asks
-- or APNs reports the device gone.
GRANT SELECT, INSERT ON apple_passes TO cl_app;
GRANT UPDATE (layout_version, updated_xid, modified_at) ON apple_passes TO cl_app;
GRANT SELECT, INSERT, DELETE ON apple_pass_registrations TO cl_app;
GRANT UPDATE (push_token) ON apple_pass_registrations TO cl_app;
