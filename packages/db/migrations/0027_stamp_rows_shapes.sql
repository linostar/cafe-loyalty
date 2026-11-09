-- migration: expand
-- Three more stamp shapes (ice cream, cake, burger), and the stamp picture laid out in rows of at most 5: Apple pass
-- layout 4 and Google pass layout 3 (APPLE_PASS_LAYOUT_VERSION, GOOGLE_PASS_LAYOUT_VERSION in packages/db wallet.ts).
-- A release from before this one cannot draw the new shapes: before rolling back past it, move any café on one of
-- them to an older shape (README, Card branding).
-- Runs as cl_owner with search_path = app.

-- 0025's CHECK, unnamed there, is PostgreSQL's cafes_stamp_shape_check; the new one only widens it.
ALTER TABLE cafes DROP CONSTRAINT cafes_stamp_shape_check;
ALTER TABLE cafes
  ADD CONSTRAINT cafes_stamp_shape_check CHECK (stamp_shape IN ('circle', 'cup', 'plate', 'bean', 'icecream', 'cake', 'burger'));

-- The sweep's policies and function (0025) with the new layouts' numbers.
DROP POLICY outdated_layout ON apple_passes;
DROP POLICY outdated_layout ON google_passes;
CREATE POLICY outdated_layout ON apple_passes FOR ALL TO cl_owner USING (layout_version < 4) WITH CHECK (layout_version = 4);
CREATE POLICY outdated_layout ON google_passes FOR ALL TO cl_owner USING (layout_version < 3) WITH CHECK (layout_version = 3);

-- CREATE OR REPLACE keeps 0025's grants (EXECUTE to cl_app only).
CREATE OR REPLACE FUNCTION mark_outdated_passes(max_rows integer) RETURNS integer
  -- STRICT: a null max_rows marks nothing. The filters repeat the policies' own.
  LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
DECLARE
  apple integer;
  google integer;
BEGIN
  UPDATE apple_passes
     SET layout_version = 4,
         updated_xid = pg_current_xact_id(),
         modified_at = greatest(date_trunc('second', now()), apple_passes.modified_at + interval '1 second')
   WHERE id IN (SELECT id FROM apple_passes WHERE layout_version < 4 ORDER BY id LIMIT max_rows);
  GET DIAGNOSTICS apple = ROW_COUNT;
  UPDATE google_passes
     SET layout_version = 3,
         updated_xid = pg_current_xact_id()
   WHERE id IN (SELECT id FROM google_passes WHERE layout_version < 3 ORDER BY id LIMIT max_rows);
  GET DIAGNOSTICS google = ROW_COUNT;
  RETURN apple + google;
END
$$;
