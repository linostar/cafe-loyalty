-- migration: expand
-- The "From logo" stamp shape ('logo'): stamps drawn as a one-colour silhouette of the café's logo, cut from it when it
-- is uploaded (cafe_logos.stamp_mask: a square PNG, white, its alpha the silhouette). A release from before this one
-- cannot draw it: before rolling back past it, move any café on it to an older shape (README, Card branding).
-- Runs as cl_owner with search_path = app.

-- Widens 0030's CHECK. Added NOT VALID (no scan under this lock; new and changed rows are checked at once) and
-- validated by 0038 under a lock that lets writes through.
ALTER TABLE cafes DROP CONSTRAINT cafes_stamp_shape_check;
ALTER TABLE cafes
  ADD CONSTRAINT cafes_stamp_shape_check CHECK (stamp_shape IN ('circle', 'cup', 'steamcup', 'plate', 'bean', 'icecream', 'cake', 'burger', 'logo')) NOT VALID;

-- The silhouette of the current logo, or null: a logo uploaded before this release has none until it is uploaded again.
ALTER TABLE cafe_logos ADD COLUMN stamp_mask bytea CHECK (octet_length(stamp_mask) BETWEEN 1 AND 2097152);
GRANT UPDATE (stamp_mask) ON cafe_logos TO cl_app;

-- A new logo saved without a silhouette of its own (by a release from before this one) drops the previous logo's, so a
-- silhouette always belongs to the logo beside it.
CREATE FUNCTION drop_stale_stamp_mask() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  IF NEW.stamp_mask IS NOT DISTINCT FROM OLD.stamp_mask THEN
    NEW.stamp_mask := NULL;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER cafe_logos_drop_stale_stamp_mask BEFORE UPDATE ON cafe_logos
  FOR EACH ROW WHEN (OLD.hash IS DISTINCT FROM NEW.hash)
  EXECUTE FUNCTION drop_stale_stamp_mask();

-- Without a silhouette (the logo removed, or replaced by one without), a café on 'logo' goes back to the circle; its
-- shape triggers (0025) then mark every current pass changed. Runs as the caller, under its café.
CREATE FUNCTION logo_stamp_to_circle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  UPDATE cafes SET stamp_shape = 'circle' WHERE id = NEW.cafe_id AND stamp_shape = 'logo';
  RETURN NULL;
END
$$;

CREATE TRIGGER cafe_logos_logo_stamp_to_circle AFTER UPDATE ON cafe_logos
  FOR EACH ROW WHEN (NEW.stamp_mask IS NULL)
  EXECUTE FUNCTION logo_stamp_to_circle();

-- A new logo of a café on 'logo' changes every Google object's stamp picture (its address names the logo), so every
-- current Google pass is marked changed, not only the one 0024 marks for the class. Runs as the caller, under its café.
CREATE FUNCTION touch_logo_stamp_google_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cafes WHERE id = NEW.cafe_id AND stamp_shape = 'logo') THEN
    UPDATE google_passes
       SET updated_xid = pg_current_xact_id()
      FROM cards
     WHERE cards.id = google_passes.card_id AND google_passes.epoch = cards.epoch AND google_passes.cafe_id = NEW.cafe_id;
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER cafe_logos_touch_logo_stamp_passes AFTER UPDATE ON cafe_logos
  FOR EACH ROW WHEN (OLD.stamp_mask IS DISTINCT FROM NEW.stamp_mask AND NEW.stamp_mask IS NOT NULL)
  EXECUTE FUNCTION touch_logo_stamp_google_passes();

REVOKE ALL ON FUNCTION drop_stale_stamp_mask() FROM PUBLIC;
REVOKE ALL ON FUNCTION logo_stamp_to_circle() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_logo_stamp_google_passes() FROM PUBLIC;
