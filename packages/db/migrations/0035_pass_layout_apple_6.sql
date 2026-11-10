-- migration: expand
-- Apple pass layout 6 (APPLE_PASS_LAYOUT_VERSION in packages/db wallet.ts): the reward and offer start-aligned instead
-- of centred. The sweep's Apple policy (0027) with the new layout as its bound; Google stays on layout 4.
-- Runs as cl_owner with search_path = app.

DROP POLICY outdated_layout ON apple_passes;
CREATE POLICY outdated_layout ON apple_passes FOR ALL TO cl_owner USING (layout_version < 6) WITH CHECK (layout_version <= 6);
