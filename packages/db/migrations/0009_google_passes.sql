-- migration: expand
-- Google Wallet passes (plan Step 10) and delivery failures of every pass, for the owner dashboard (AC 13).
--
-- A Google pass is a card's loyalty object at one epoch; its object id derives from the card id and the epoch (AC 12),
-- so a retried write updates the object rather than making another. Recovery gives the card a new epoch, and with it a
-- new object for the new phone; the old one is written INACTIVE (AC 8). Deleting the card deletes its rows (AC 9).
--
-- A change to a card's stamps or epoch marks its Google passes changed, as cards_touch_apple_passes does for Apple
-- (migration 0008), so the application queues their writes from the same transaction.
-- Runs as cl_owner with search_path = app.

CREATE TABLE google_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  card_id uuid NOT NULL,
  -- The card's epoch the object was issued at; an object of an earlier epoch is written INACTIVE.
  epoch integer NOT NULL CHECK (epoch >= 1),
  -- The transaction that last changed the pass.
  updated_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  -- Failed writes to Google in a row, the last one's time and its error code (never personal data); reset by a write
  -- that succeeds.
  delivery_failures integer NOT NULL DEFAULT 0 CHECK (delivery_failures >= 0),
  delivery_failed_at timestamptz,
  delivery_error text CHECK (char_length(delivery_error) <= 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_passes_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT google_passes_card_epoch_key UNIQUE (card_id, epoch),
  CONSTRAINT google_passes_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE CASCADE
);

-- Failed pushes of an Apple pass, as for Google passes above.
ALTER TABLE apple_passes
  ADD COLUMN delivery_failures integer NOT NULL DEFAULT 0 CHECK (delivery_failures >= 0),
  ADD COLUMN delivery_failed_at timestamptz,
  ADD COLUMN delivery_error text CHECK (char_length(delivery_error) <= 64);

-- As touch_apple_passes: a stamp change marks the card's current pass, an epoch change the pass it replaced.
CREATE FUNCTION touch_google_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  UPDATE google_passes SET updated_xid = pg_current_xact_id() WHERE card_id = NEW.id AND epoch = OLD.epoch;
  RETURN NULL;
END
$$;

CREATE TRIGGER cards_touch_google_passes AFTER UPDATE OF stamps, epoch ON cards
  FOR EACH ROW WHEN (OLD.stamps IS DISTINCT FROM NEW.stamps OR OLD.epoch IS DISTINCT FROM NEW.epoch)
  EXECUTE FUNCTION touch_google_passes();

ALTER TABLE google_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_passes FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON google_passes TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- Runtime privileges. Passes go with their card (the foreign key's cascade).
GRANT SELECT, INSERT ON google_passes TO cl_app;
GRANT UPDATE (updated_xid, delivery_failures, delivery_failed_at, delivery_error) ON google_passes TO cl_app;
GRANT UPDATE (delivery_failures, delivery_failed_at, delivery_error) ON apple_passes TO cl_app;
REVOKE ALL ON FUNCTION touch_google_passes() FROM PUBLIC;
