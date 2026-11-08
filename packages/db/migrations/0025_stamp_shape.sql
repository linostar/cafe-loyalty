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
