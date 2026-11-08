-- migration: expand
-- A café's card branding: its card colours, set by the operator, and its logo, uploaded by the operator or the owner.
-- Every card shows them (the Apple pass, the Google class, the web card). Today's colours are the defaults, so a café
-- that never sets its own looks as before.
--
-- A change to a café's name, colours or logo marks every current pass of its cards changed in the database itself, as
-- cards_touch_apple_passes does for stamps, so the worker's sweep (undelivered_passes) brings every wallet up to date,
-- silently, whichever release made the change.
-- Runs as cl_owner with search_path = app.

-- Background, text and label colours, as lowercase #rrggbb (the API checks their contrast, 4.5:1 against the background).
ALTER TABLE cafes
  ADD COLUMN card_background text NOT NULL DEFAULT '#4a2c2a' CHECK (card_background ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN card_foreground text NOT NULL DEFAULT '#ffffff' CHECK (card_foreground ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN card_label text NOT NULL DEFAULT '#ebd6be' CHECK (card_label ~ '^#[0-9a-f]{6}$'),
  -- SHA-256 of the Google loyalty class the worker last wrote for the café, or null: a class built differently (a new
  -- name, colour or logo) is written to Google again before the café's next object.
  ADD COLUMN google_class_hash bytea CHECK (octet_length(google_class_hash) = 32);

-- A café's logo, in the sizes its cards use: a square PNG (the Google class and the web card) and Apple's logo.png at
-- 1x, 2x and 3x. hash is the SHA-256 of the square PNG, which is served publicly at /logos/<hash>.png (Google fetches
-- it): found through current_secret_hash() (withLookup), so the address names no café.
CREATE TABLE cafe_logos (
  cafe_id uuid PRIMARY KEY REFERENCES cafes (id) ON DELETE CASCADE,
  hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  square bytea NOT NULL CHECK (octet_length(square) BETWEEN 1 AND 1048576),
  apple_1x bytea NOT NULL CHECK (octet_length(apple_1x) BETWEEN 1 AND 1048576),
  apple_2x bytea NOT NULL CHECK (octet_length(apple_2x) BETWEEN 1 AND 1048576),
  apple_3x bytea NOT NULL CHECK (octet_length(apple_3x) BETWEEN 1 AND 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cafe_logos_hash_idx ON cafe_logos (hash);

CREATE TRIGGER cafe_logos_touch_updated_at BEFORE UPDATE ON cafe_logos
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Marks every current pass of a café's cards changed (its cards' current epochs; passes of earlier epochs are voided
-- and stay as they are). Runs as the caller, under its café.
CREATE FUNCTION touch_cafe_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
DECLARE
  target uuid;
BEGIN
  IF TG_TABLE_NAME = 'cafes' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.cafe_id;
  ELSE
    target := NEW.cafe_id;
  END IF;
  UPDATE apple_passes
     SET updated_xid = pg_current_xact_id(),
         modified_at = greatest(date_trunc('second', now()), apple_passes.modified_at + interval '1 second')
    FROM cards
   WHERE cards.id = apple_passes.card_id AND apple_passes.epoch = cards.epoch AND apple_passes.cafe_id = target;
  UPDATE google_passes
     SET updated_xid = pg_current_xact_id()
    FROM cards
   WHERE cards.id = google_passes.card_id AND google_passes.epoch = cards.epoch AND google_passes.cafe_id = target;
  RETURN NULL;
END
$$;

CREATE TRIGGER cafes_touch_passes AFTER UPDATE OF name, card_background, card_foreground, card_label ON cafes
  FOR EACH ROW WHEN (
    OLD.name IS DISTINCT FROM NEW.name
    OR OLD.card_background IS DISTINCT FROM NEW.card_background
    OR OLD.card_foreground IS DISTINCT FROM NEW.card_foreground
    OR OLD.card_label IS DISTINCT FROM NEW.card_label
  )
  EXECUTE FUNCTION touch_cafe_passes();

CREATE TRIGGER cafe_logos_touch_passes AFTER INSERT OR DELETE ON cafe_logos
  FOR EACH ROW EXECUTE FUNCTION touch_cafe_passes();

CREATE TRIGGER cafe_logos_touch_passes_on_change AFTER UPDATE ON cafe_logos
  FOR EACH ROW WHEN (OLD.hash IS DISTINCT FROM NEW.hash)
  EXECUTE FUNCTION touch_cafe_passes();

ALTER TABLE cafe_logos ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafe_logos FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON cafe_logos TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
-- The public logo address: the logo whose hash is looked up, whatever its café (the image is public).
CREATE POLICY logo_by_hash ON cafe_logos FOR SELECT TO cl_app
  USING (hash = current_secret_hash());

-- Runtime privileges: a logo is replaced (upsert) or removed by its café's owner or the operator.
GRANT SELECT, INSERT, DELETE ON cafe_logos TO cl_app;
GRANT UPDATE (hash, square, apple_1x, apple_2x, apple_3x) ON cafe_logos TO cl_app;
REVOKE ALL ON FUNCTION touch_cafe_passes() FROM PUBLIC;
