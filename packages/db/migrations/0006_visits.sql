-- migration: expand
-- Stamping (plan Step 9): visits with their items, stamps added to cards under a per-card cooldown and a daily cap
-- per device (AC 30), online-only reward redemptions (AC 31), and sync refusals kept in the ledger, so an event sent
-- again gets its first answer (AC 24).
-- Runs as cl_owner with search_path = app.

-- For the cooldown's exclusion constraint (uuid equality in a GiST index). A trusted extension: the database owner,
-- cl_owner, may create it.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- The 30 minutes after a stamped visit in which the same card gets no more stamps. IMMUTABLE is true here: a fixed
-- number of minutes does not depend on the time zone (timestamptz + interval is only STABLE because of day and month
-- intervals), and an index expression needs it.
CREATE FUNCTION stamp_cooldown_window(stamped_at timestamptz) RETURNS tstzrange
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT pg_catalog.tstzrange(stamped_at, stamped_at + interval '30 minutes') $$;

-- payload_hash (0005) is an HMAC keyed with the phone lookup pepper from here on, not a plain SHA-256: visits and
-- their items store everything else of a phone visit's signed bytes, so a plain hash would give the number away to
-- anyone with a copy of the database. The server computes it; nothing in the schema changes.
-- A refused event (unknown card, a card replaced by recovery, an unconfirmed phone number) is kept with its code. A
-- visit that arrives more than two days after it happened is held for the owner (late_sync): the daily cap and the
-- cooldown go by the visit's own time, which the device sets, so backdated visits must not stamp unseen.
ALTER TABLE sync_events
  DROP CONSTRAINT sync_events_hold_reason_check,
  ADD CONSTRAINT sync_events_hold_reason_check CHECK (hold_reason IN ('device_revoked', 'staff_revoked', 'late_sync')),
  ADD COLUMN result_code text CHECK (result_code ~ '^[A-Z][A-Z_]{0,63}$'),
  ADD CONSTRAINT sync_events_cafe_id_id_key UNIQUE (cafe_id, id),
  DROP CONSTRAINT sync_events_status_check,
  ADD CONSTRAINT sync_events_status_check CHECK (status IN ('applied', 'held', 'discarded', 'rejected')),
  DROP CONSTRAINT sync_events_review_check,
  -- Applied directly; refused (with its code); or held, then accepted (applied) or discarded by an owner, who is recorded.
  ADD CONSTRAINT sync_events_review_check CHECK (
    (hold_reason IS NULL AND status = 'applied' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (hold_reason IS NULL AND status = 'rejected' AND result_code IS NOT NULL AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (hold_reason IS NOT NULL AND status = 'held' AND reviewed_at IS NULL AND reviewed_by IS NULL)
    OR (hold_reason IS NOT NULL AND status IN ('applied', 'discarded') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
  );

-- Stamping by phone number needs a card first seen at the counter by its QR (phone numbers are not verified). A scan
-- proves who holds the card, not who owns the number: when a second card here signs up with the same number, the
-- number is disputed and its card is never stamped by number again (QR only), so a squatter cannot keep the stamps
-- the number's owner asks for.
ALTER TABLE cards
  ADD COLUMN phone_confirmed_at timestamptz,
  ADD COLUMN phone_disputed_at timestamptz;

CREATE TABLE visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  sync_event_id uuid NOT NULL,
  -- Set null when the card is deleted, so a visit keeps no link to a person (AC 9).
  card_id uuid,
  identified_by text NOT NULL CHECK (identified_by IN ('qr', 'phone')),
  device_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  total_cents integer NOT NULL CHECK (total_cents BETWEEN 0 AND 100000000),
  -- What the items earn, and what the card got: less under the cooldown or the device's daily cap (AC 30).
  stamps_earned integer NOT NULL CHECK (stamps_earned >= 0),
  stamps_added integer NOT NULL DEFAULT 0 CHECK (stamps_added >= 0 AND stamps_added <= stamps_earned),
  outcome text NOT NULL CHECK (outcome IN ('held', 'discarded', 'stamped', 'no_stamps', 'cooldown', 'daily_cap', 'card_gone')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visits_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT visits_sync_event_key UNIQUE (cafe_id, sync_event_id),
  CONSTRAINT visits_sync_event_fkey FOREIGN KEY (cafe_id, sync_event_id) REFERENCES sync_events (cafe_id, id),
  CONSTRAINT visits_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE SET NULL (card_id),
  CONSTRAINT visits_device_fkey FOREIGN KEY (cafe_id, device_id) REFERENCES devices (cafe_id, id),
  CONSTRAINT visits_staff_fkey FOREIGN KEY (cafe_id, staff_id) REFERENCES staff (cafe_id, id),
  -- The per-card cooldown, enforced here (AC 30): two visits that added stamps to one card are at least 30 minutes
  -- apart. Keep in step with STAMP_COOLDOWN_MINUTES (apps/server/src/stamping.ts).
  CONSTRAINT visits_card_cooldown EXCLUDE USING gist (card_id WITH =, stamp_cooldown_window(occurred_at) WITH &&) WHERE (stamps_added > 0)
);

CREATE INDEX visits_card_idx ON visits (cafe_id, card_id, occurred_at) WHERE card_id IS NOT NULL;
CREATE INDEX visits_device_day_idx ON visits (cafe_id, device_id, occurred_at) WHERE stamps_added > 0;

-- What a visit was, priced as the counter saw it: the server never re-prices from today's catalog (AC 32).
CREATE TABLE visit_items (
  cafe_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  line smallint NOT NULL CHECK (line BETWEEN 0 AND 29),
  order_type_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 100000000),
  unit_cost_cents integer NOT NULL CHECK (unit_cost_cents BETWEEN 0 AND 100000000),
  catalog_version integer NOT NULL CHECK (catalog_version >= 1),
  -- The order type's stamps when the visit was applied.
  stamps_each integer NOT NULL CHECK (stamps_each BETWEEN 0 AND 10),
  PRIMARY KEY (visit_id, line),
  CONSTRAINT visit_items_visit_fkey FOREIGN KEY (cafe_id, visit_id) REFERENCES visits (cafe_id, id),
  CONSTRAINT visit_items_order_type_fkey FOREIGN KEY (cafe_id, order_type_id) REFERENCES order_types (cafe_id, id)
);

-- Rewards given at the counter, online only (AC 31). The device's event id makes a retry return the first answer.
CREATE TABLE redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  device_id uuid NOT NULL,
  event_id uuid NOT NULL,
  -- Set null when the card is deleted (AC 9).
  card_id uuid,
  staff_id uuid NOT NULL,
  stamps_used integer NOT NULL CHECK (stamps_used >= 1),
  stamps_left integer NOT NULL CHECK (stamps_left >= 0),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redemptions_event_key UNIQUE (cafe_id, device_id, event_id),
  CONSTRAINT redemptions_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE SET NULL (card_id),
  CONSTRAINT redemptions_device_fkey FOREIGN KEY (cafe_id, device_id) REFERENCES devices (cafe_id, id),
  CONSTRAINT redemptions_staff_fkey FOREIGN KEY (cafe_id, staff_id) REFERENCES staff (cafe_id, id)
);

ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON visits TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE visit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_items FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON visit_items TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE redemptions FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON redemptions TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- Runtime privileges. Visits, their items and redemptions are never deleted; only a held visit's outcome changes.
GRANT SELECT, INSERT ON visits TO cl_app;
GRANT UPDATE (stamps_added, outcome) ON visits TO cl_app;
GRANT SELECT, INSERT ON visit_items TO cl_app;
GRANT SELECT, INSERT ON redemptions TO cl_app;
GRANT UPDATE (stamps, phone_confirmed_at, phone_disputed_at) ON cards TO cl_app;
REVOKE ALL ON FUNCTION stamp_cooldown_window(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stamp_cooldown_window(timestamptz) TO cl_app;
