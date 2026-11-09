-- migration: expand
-- Apple pass layout 5 and Google pass layout 4 (APPLE_PASS_LAYOUT_VERSION, GOOGLE_PASS_LAYOUT_VERSION in packages/db
-- wallet.ts): full stamps as big as empty ones (the stamp picture at /stamps/v3/), and on Apple the reward and offer
-- centred and space above the logo. The sweep's policies (0027) with the new layouts as their bound; the function
-- stays as it is (each release's worker passes its own layouts).
-- Runs as cl_owner with search_path = app.

DROP POLICY outdated_layout ON apple_passes;
DROP POLICY outdated_layout ON google_passes;
CREATE POLICY outdated_layout ON apple_passes FOR ALL TO cl_owner USING (layout_version < 5) WITH CHECK (layout_version <= 5);
CREATE POLICY outdated_layout ON google_passes FOR ALL TO cl_owner USING (layout_version < 4) WITH CHECK (layout_version <= 4);
