-- migration: expand
-- Only create-operator, connected as the migrator (cl_owner), creates operators: a compromised server (cl_app) could
-- otherwise add an operator of its own, which outlives the fix and the redeploy. cl_app keeps UPDATE of an operator's
-- password for the self-service change. Safe for the running release, which never inserts operators; a previous
-- release's own create-operator (as cl_app) fails once this is applied, so after a rollback run this release's (README,
-- Deploying).
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

-- Nor may it leave a session behind that outlives the fix: cl_app inserts only what sign-in sets (the start comes from
-- the database), and no session lasts past 12 hours from its start, so each one ends, and purge_expired deletes it, by
-- then. Sign-in sets the end from the database's clock too (secondsFromNow), at exactly this bound: raising
-- OPERATOR_SESSION_ABSOLUTE_TIMEOUT_SECONDS needs a migration that raises it here first.
REVOKE INSERT ON operator_sessions FROM cl_app;
GRANT INSERT (operator_id, token_hash, expires_at) ON operator_sessions TO cl_app;
ALTER TABLE operator_sessions ADD CONSTRAINT operator_sessions_lifetime_check CHECK (expires_at <= created_at + interval '12 hours');
