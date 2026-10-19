-- migration: expand
-- Only create-operator, connected as the migrator (cl_owner), creates operators: a compromised server (cl_app) could
-- otherwise add an operator of its own, which outlives the fix and the redeploy. cl_app keeps UPDATE of an operator's
-- own password for the self-service change. Safe for the running release: the server never inserts operators (only
-- the create-operator command did, and it now connects as the migrator).
REVOKE INSERT ON operators FROM cl_app;

-- Both tables force row-level security, which binds their owner too, so create-operator needs policies of its own,
-- scoped like the app's to the one operator it sets (by email, then by id): purge_expired_credentials also runs as
-- cl_owner and deletes from operator_sessions with no WHERE, relying on its purge_expired policy (migration 0016)
-- alone, so no cl_owner policy may show it any other session. Not FOR DELETE only: a DELETE's WHERE also needs the
-- rows to pass a SELECT policy.
CREATE POLICY operator_admin ON operators TO cl_owner
  USING (email = current_operator_email()) WITH CHECK (email = current_operator_email());
CREATE POLICY operator_session_admin ON operator_sessions TO cl_owner
  USING (operator_id = current_operator_id()) WITH CHECK (operator_id = current_operator_id());
