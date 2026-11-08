-- migration: expand
-- A café's stamp shape: the template its cards draw their stamps in (an empty outline or a full shape), chosen by the
-- owner or the operator. Every card shows its stamps as a picture of these shapes in the café's background and text
-- colours (the Apple strip, the Google hero image, the web card); 'circle' is what every café starts with.
--
-- Each Google object now carries its own stamp picture, whose address holds the shape and those two colours, so a
-- change to either marks every current Google pass changed, not only the one 0024 marks for the class.
-- Runs as cl_owner with search_path = app.

ALTER TABLE cafes
  ADD COLUMN stamp_shape text NOT NULL DEFAULT 'circle' CHECK (stamp_shape IN ('circle', 'cup', 'plate', 'bean'));

-- Marks every current Google pass of a café's cards changed (current epochs; earlier passes are voided and stay as
-- they are). Runs as the caller, under its café.
CREATE FUNCTION touch_cafe_google_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  UPDATE google_passes
     SET updated_xid = pg_current_xact_id()
    FROM cards
   WHERE cards.id = google_passes.card_id AND google_passes.epoch = cards.epoch AND google_passes.cafe_id = NEW.id;
  RETURN NULL;
END
$$;

-- A new shape changes every pass, as a new colour does (touch_cafe_passes: Apple passes and the class).
CREATE TRIGGER cafes_touch_passes_on_shape AFTER UPDATE OF stamp_shape ON cafes
  FOR EACH ROW WHEN (OLD.stamp_shape IS DISTINCT FROM NEW.stamp_shape)
  EXECUTE FUNCTION touch_cafe_passes();

CREATE TRIGGER cafes_touch_google_passes AFTER UPDATE OF stamp_shape, card_background, card_foreground ON cafes
  FOR EACH ROW WHEN (
    OLD.stamp_shape IS DISTINCT FROM NEW.stamp_shape
    OR OLD.card_background IS DISTINCT FROM NEW.card_background
    OR OLD.card_foreground IS DISTINCT FROM NEW.card_foreground
  )
  EXECUTE FUNCTION touch_cafe_google_passes();

REVOKE ALL ON FUNCTION touch_cafe_google_passes() FROM PUBLIC;

-- Pass layouts (APPLE_PASS_LAYOUT_VERSION, GOOGLE_PASS_LAYOUT_VERSION in packages/db wallet.ts): the stamp picture is
-- Apple layout 3 and Google layout 2. Google passes now record theirs too; every one made before is layout 1.
ALTER TABLE google_passes ADD COLUMN layout_version integer NOT NULL DEFAULT 1 CHECK (layout_version >= 1);

-- The worker's sweep (every 15 minutes, before it queues undelivered passes) marks passes on an older layout changed
-- and records the new one, at most max_rows of each wallet a run, so a pass nobody stamps or fetches gets the new
-- layout too, once. Runs as cl_owner, which sees and changes only such passes through the policies below, and returns
-- a count only; the app role may only call it. Voided passes are included: they are rebuilt voided, as before.
-- A future layout bump replaces these policies and the function with its own numbers.
CREATE POLICY outdated_layout ON apple_passes FOR ALL TO cl_owner USING (layout_version < 3) WITH CHECK (layout_version = 3);
CREATE POLICY outdated_layout ON google_passes FOR ALL TO cl_owner USING (layout_version < 2) WITH CHECK (layout_version = 2);

CREATE FUNCTION mark_outdated_passes(max_rows integer) RETURNS integer
  -- STRICT: a null max_rows marks nothing. The filters repeat the policies' own.
  LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
DECLARE
  apple integer;
  google integer;
BEGIN
  UPDATE apple_passes
     SET layout_version = 3,
         updated_xid = pg_current_xact_id(),
         modified_at = greatest(date_trunc('second', now()), apple_passes.modified_at + interval '1 second')
   WHERE id IN (SELECT id FROM apple_passes WHERE layout_version < 3 ORDER BY id LIMIT max_rows);
  GET DIAGNOSTICS apple = ROW_COUNT;
  UPDATE google_passes
     SET layout_version = 2,
         updated_xid = pg_current_xact_id()
   WHERE id IN (SELECT id FROM google_passes WHERE layout_version < 2 ORDER BY id LIMIT max_rows);
  GET DIAGNOSTICS google = ROW_COUNT;
  RETURN apple + google;
END
$$;

REVOKE ALL ON FUNCTION mark_outdated_passes(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_outdated_passes(integer) TO cl_app;
