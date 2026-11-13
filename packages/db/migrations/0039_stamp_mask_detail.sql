-- migration: expand
-- "From logo" silhouettes, cut again with the logo's inner detail (the server's STAMP_MASK_VERSION 2: a logo's dark
-- visible parts are inked, where version 1 took a transparent logo's whole outline). Each silhouette now records its own
-- SHA-256, which addresses it and its stamp pictures (a re-cut is a new address no cache holds), and the version of the
-- cut, so the server re-cuts older ones (and logos from before 0037, which have none) from their stored square at
-- start-up. A changed silhouette of a café on 'logo' marks every current pass of its cards.
-- Runs as cl_owner with search_path = app.

ALTER TABLE cafe_logos
  ADD COLUMN stamp_mask_hash bytea CHECK (octet_length(stamp_mask_hash) = 32),
  ADD COLUMN stamp_mask_version smallint CHECK (stamp_mask_version > 0);
GRANT UPDATE (stamp_mask_hash, stamp_mask_version) ON cafe_logos TO cl_app;

CREATE INDEX cafe_logos_stamp_mask_hash_idx ON cafe_logos (stamp_mask_hash);

-- The public silhouette address: the silhouette whose hash is looked up, whatever its café (the image is public).
CREATE POLICY stamp_mask_by_hash ON cafe_logos FOR SELECT TO cl_app
  USING (stamp_mask_hash = current_secret_hash());

-- 0037's, also dropping the stale silhouette's hash and version.
CREATE OR REPLACE FUNCTION drop_stale_stamp_mask() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  IF NEW.stamp_mask_for IS DISTINCT FROM NEW.hash THEN
    NEW.stamp_mask := NULL;
    NEW.stamp_mask_for := NULL;
    NEW.stamp_mask_hash := NULL;
    NEW.stamp_mask_version := NULL;
  END IF;
  RETURN NEW;
END
$$;

-- The cafés whose logo's silhouette is missing or cut by an older version than the caller's. Like cafes_for_feedback
-- (0015), it runs as cl_owner, which this policy lets read logos, and returns ids only; each re-cut is then done inside
-- withCafe.
CREATE POLICY stamp_mask_recut ON cafe_logos FOR SELECT TO cl_owner USING (true);

CREATE FUNCTION cafes_with_outdated_stamp_masks(current_version integer)
  RETURNS TABLE (cafe_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
  SELECT cafe_id FROM cafe_logos
   WHERE square IS NOT NULL AND (stamp_mask_version IS NULL OR stamp_mask_version < current_version)
   ORDER BY cafe_id
  $$;

-- A new silhouette of a café on 'logo' (a re-cut, which keeps the logo's hash) changes every pass's stamps: every
-- current Apple and Google pass is marked changed. Runs as the caller, under its café.
CREATE FUNCTION touch_logo_stamp_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cafes WHERE id = NEW.cafe_id AND stamp_shape = 'logo') THEN
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

CREATE TRIGGER cafe_logos_touch_stamp_mask_passes AFTER UPDATE ON cafe_logos
  FOR EACH ROW WHEN (OLD.stamp_mask_hash IS DISTINCT FROM NEW.stamp_mask_hash AND NEW.stamp_mask_hash IS NOT NULL)
  EXECUTE FUNCTION touch_logo_stamp_passes();

REVOKE ALL ON FUNCTION cafes_with_outdated_stamp_masks(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cafes_with_outdated_stamp_masks(integer) TO cl_app;
REVOKE ALL ON FUNCTION touch_logo_stamp_passes() FROM PUBLIC;
