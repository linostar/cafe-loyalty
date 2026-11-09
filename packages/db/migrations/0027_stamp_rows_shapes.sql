-- migration: expand
-- Three more stamp shapes (ice cream, cake, burger), and the stamp picture laid out in rows of at most 5: Apple pass
-- layout 4 and Google pass layout 3 (APPLE_PASS_LAYOUT_VERSION, GOOGLE_PASS_LAYOUT_VERSION in packages/db wallet.ts).
-- A release from before this one cannot draw the new shapes: before rolling back past it, move any café on one of
-- them to an older shape (README, Card branding).
-- Runs as cl_owner with search_path = app.

-- 0025's CHECK, unnamed there, is PostgreSQL's cafes_stamp_shape_check; the new one only widens it. Added NOT VALID
-- (no scan under this lock; new and changed rows are checked at once) and validated by 0028 under a lock that lets
-- writes through.
ALTER TABLE cafes DROP CONSTRAINT cafes_stamp_shape_check;
ALTER TABLE cafes
  ADD CONSTRAINT cafes_stamp_shape_check CHECK (stamp_shape IN ('circle', 'cup', 'plate', 'bean', 'icecream', 'cake', 'burger')) NOT VALID;

-- The sweep's policies (0025), now up to the newest layouts this schema knows: cl_owner sees a pass only while it is on
-- an older layout, and may move it no further than the newest. A future layout bump replaces these two policies only.
DROP POLICY outdated_layout ON apple_passes;
DROP POLICY outdated_layout ON google_passes;
CREATE POLICY outdated_layout ON apple_passes FOR ALL TO cl_owner USING (layout_version < 4) WITH CHECK (layout_version <= 4);
CREATE POLICY outdated_layout ON google_passes FOR ALL TO cl_owner USING (layout_version < 3) WITH CHECK (layout_version <= 3);

-- The sweep, moving passes onto the layouts of the release that runs it: the worker passes its own
-- APPLE_PASS_LAYOUT_VERSION and GOOGLE_PASS_LAYOUT_VERSION, so an older release's worker (during a deploy, before the
-- new one starts, or after a rollback) never records a layout it does not build; that release calls 0025's
-- mark_outdated_passes(integer), left as it was (layouts 3 and 2). Passes are only ever moved up, at most max_rows of
-- each wallet a run. Runs as cl_owner, which sees and changes only outdated passes through the policies above, and
-- returns a count only; the app role may only call it.
CREATE FUNCTION mark_outdated_passes(max_rows integer, apple_layout integer, google_layout integer) RETURNS integer
  -- STRICT: a null argument marks nothing. The filters repeat the policies' own.
  LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
DECLARE
  apple integer;
  google integer;
BEGIN
  UPDATE apple_passes
     SET layout_version = apple_layout,
         updated_xid = pg_current_xact_id(),
         modified_at = greatest(date_trunc('second', now()), apple_passes.modified_at + interval '1 second')
   WHERE id IN (SELECT id FROM apple_passes WHERE layout_version < apple_layout ORDER BY id LIMIT max_rows);
  GET DIAGNOSTICS apple = ROW_COUNT;
  UPDATE google_passes
     SET layout_version = google_layout,
         updated_xid = pg_current_xact_id()
   WHERE id IN (SELECT id FROM google_passes WHERE layout_version < google_layout ORDER BY id LIMIT max_rows);
  GET DIAGNOSTICS google = ROW_COUNT;
  RETURN apple + google;
END
$$;

REVOKE ALL ON FUNCTION mark_outdated_passes(integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_outdated_passes(integer, integer, integer) TO cl_app;
