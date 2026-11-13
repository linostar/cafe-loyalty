-- migration: expand
-- The "From picture" stamp shape ('picture'): stamps drawn, like "From logo" (0037, 0039), as a one-colour silhouette,
-- but cut from a picture the café uploads for its stamps alone, which its cards never show as their logo. A release
-- from before this one cannot draw it: before rolling back past it, move any café on it to an older shape (README,
-- Card branding).
-- Runs as cl_owner with search_path = app.

-- Widens 0037's CHECK. Added NOT VALID (no scan under this lock; new and changed rows are checked at once) and
-- validated by 0041 under a lock that lets writes through.
ALTER TABLE cafes DROP CONSTRAINT cafes_stamp_shape_check;
ALTER TABLE cafes
  ADD CONSTRAINT cafes_stamp_shape_check CHECK (stamp_shape IN ('circle', 'cup', 'steamcup', 'plate', 'bean', 'icecream', 'cake', 'burger', 'logo', 'picture')) NOT VALID;

-- A café's "From picture" picture: the upload as a square PNG (kept so the server can cut it again, as it does logos) and
-- its silhouette (a square PNG, white, its alpha the silhouette), with the silhouette's own SHA-256 (its public address
-- and its stamp pictures', /logos/<hash>-stamp.png, shared with logo silhouettes) and the version of the cut. Removing
-- the picture deletes the row. Sizes as cafe_logos' (0024).
CREATE TABLE cafe_pictures (
  cafe_id uuid PRIMARY KEY REFERENCES cafes (id) ON DELETE CASCADE,
  square bytea NOT NULL CHECK (octet_length(square) BETWEEN 1 AND 2097152),
  stamp_mask bytea NOT NULL CHECK (octet_length(stamp_mask) BETWEEN 1 AND 2097152),
  stamp_mask_hash bytea NOT NULL CHECK (octet_length(stamp_mask_hash) = 32),
  stamp_mask_version smallint NOT NULL CHECK (stamp_mask_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cafe_pictures_stamp_mask_hash_idx ON cafe_pictures (stamp_mask_hash);

CREATE TRIGGER cafe_pictures_touch_updated_at BEFORE UPDATE ON cafe_pictures
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Without its picture a café on 'picture' goes back to the circle; its shape triggers (0025) then mark every current
-- pass changed. Runs as the caller, under its café (a café's own deletion finds no café left to update).
CREATE FUNCTION picture_stamp_to_circle() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  UPDATE cafes SET stamp_shape = 'circle' WHERE id = OLD.cafe_id AND stamp_shape = 'picture';
  RETURN NULL;
END
$$;

CREATE TRIGGER cafe_pictures_picture_stamp_to_circle AFTER DELETE ON cafe_pictures
  FOR EACH ROW EXECUTE FUNCTION picture_stamp_to_circle();

-- 0039's, now for either source: a new silhouette of a café on the shape drawn from it ('logo' from cafe_logos,
-- 'picture' from cafe_pictures) marks every current Apple and Google pass changed. Runs as the caller, under its café.
CREATE OR REPLACE FUNCTION touch_logo_stamp_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cafes WHERE id = NEW.cafe_id AND stamp_shape = CASE TG_TABLE_NAME WHEN 'cafe_pictures' THEN 'picture' ELSE 'logo' END) THEN
    UPDATE apple_passes
       SET updated_xid = pg_current_xact_id(),
           modified_at = greatest(date_trunc('second', now()), apple_passes.modified_at + interval '1 second')
      FROM cards
     WHERE cards.id = apple_passes.card_id AND apple_passes.epoch = cards.epoch AND apple_passes.cafe_id = NEW.cafe_id;
    UPDATE google_passes
       SET updated_xid = pg_current_xact_id()
      FROM cards
     WHERE cards.id = google_passes.card_id AND google_passes.epoch = cards.epoch AND google_passes.cafe_id = NEW.cafe_id;
  END IF;
  RETURN NULL;
END
$$;

-- A new picture of a café already on 'picture' (a replacement, or a re-cut). A first picture needs none: the café
-- cannot be on 'picture' without one, and picking it changes the shape, whose triggers mark the passes.
CREATE TRIGGER cafe_pictures_touch_stamp_mask_passes AFTER UPDATE ON cafe_pictures
  FOR EACH ROW WHEN (OLD.stamp_mask_hash IS DISTINCT FROM NEW.stamp_mask_hash)
  EXECUTE FUNCTION touch_logo_stamp_passes();

ALTER TABLE cafe_pictures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafe_pictures FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON cafe_pictures TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
-- The public silhouette address: the silhouette whose hash is looked up, whatever its café (the image is public).
CREATE POLICY stamp_mask_by_hash ON cafe_pictures FOR SELECT TO cl_app
  USING (stamp_mask_hash = current_secret_hash());
-- Read by cafes_with_outdated_stamp_masks (below), which runs as cl_owner.
CREATE POLICY stamp_mask_recut ON cafe_pictures FOR SELECT TO cl_owner USING (true);

-- 0039's, now also listing cafés whose picture's silhouette was cut by an older version than the caller's.
CREATE OR REPLACE FUNCTION cafes_with_outdated_stamp_masks(current_version integer)
  RETURNS TABLE (cafe_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
  SELECT cafe_id FROM cafe_logos
   WHERE square IS NOT NULL AND (stamp_mask_version IS NULL OR stamp_mask_version < current_version)
  UNION
  SELECT cafe_id FROM cafe_pictures WHERE stamp_mask_version < current_version
  ORDER BY cafe_id
  $$;

-- Runtime privileges: a picture is set (upsert) or removed (delete) by its café's owner or the operator, and re-cut by
-- the server.
GRANT SELECT, INSERT, DELETE ON cafe_pictures TO cl_app;
GRANT UPDATE (square, stamp_mask, stamp_mask_hash, stamp_mask_version) ON cafe_pictures TO cl_app;
REVOKE ALL ON FUNCTION picture_stamp_to_circle() FROM PUBLIC;
