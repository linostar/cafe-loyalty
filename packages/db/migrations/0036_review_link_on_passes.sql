-- migration: expand
-- The café's Google review link on every pass, whatever the visit (AC 37): an Apple back field and a link on the Google
-- class. A new, changed or cleared link marks the café's passes changed as its name does (touch_cafe_passes, 0024:
-- every current Apple pass, and one Google pass whose job writes the class again).
-- Apple layout 7 and Google layout 5 (packages/db wallet.ts) bring the link to passes nobody stamps: the sweep's
-- policies (0027) with the new layouts as their bound.
-- Runs as cl_owner with search_path = app.

CREATE TRIGGER cafes_touch_passes_on_review_url AFTER UPDATE OF google_review_url ON cafes
  FOR EACH ROW WHEN (OLD.google_review_url IS DISTINCT FROM NEW.google_review_url)
  EXECUTE FUNCTION touch_cafe_passes();

DROP POLICY outdated_layout ON apple_passes;
DROP POLICY outdated_layout ON google_passes;
CREATE POLICY outdated_layout ON apple_passes FOR ALL TO cl_owner USING (layout_version < 7) WITH CHECK (layout_version <= 7);
CREATE POLICY outdated_layout ON google_passes FOR ALL TO cl_owner USING (layout_version < 5) WITH CHECK (layout_version <= 5);
