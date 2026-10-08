-- migration: expand
-- Owner accounts, operator invites, owner sessions and password reset tokens.
-- Signing in, opening an invite or reset link and checking a session cookie all happen before any café is known.
-- Each of those reads is allowed by a SELECT-only policy keyed on what the caller already holds: the owner's email
-- (current_owner_email(), for signing in) or the SHA-256 hash of a session, invite or reset token
-- (current_secret_hash()). Both come from transaction-local settings that withLookup sets. Every write still needs
-- the café that withCafe sets.
-- Runs as cl_owner with search_path = app.

CREATE FUNCTION current_owner_email() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.owner_email', true), '') $$;

CREATE FUNCTION current_secret_hash() RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT pg_catalog.decode(NULLIF(pg_catalog.current_setting('app.secret_hash', true), ''), 'hex') $$;

CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  -- The sign-in name, lower-cased by the app, so unique across every café.
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  -- argon2id in PHC string format.
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 1 AND 512),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owners_email_key UNIQUE (email),
  CONSTRAINT owners_cafe_id_id_key UNIQUE (cafe_id, id)
);

-- Single-use signup links the operator creates together with the café.
CREATE TABLE owner_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_invites_token_hash_key UNIQUE (token_hash)
);

CREATE TABLE owner_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The idle timeout counts from here.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The absolute timeout.
  expires_at timestamptz NOT NULL,
  CONSTRAINT owner_sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT owner_sessions_owner_fkey FOREIGN KEY (cafe_id, owner_id) REFERENCES owners (cafe_id, id)
);

CREATE INDEX owner_sessions_owner_idx ON owner_sessions (cafe_id, owner_id);

-- A token is used by deleting its row, so it can be used only once.
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT password_reset_tokens_owner_fkey FOREIGN KEY (cafe_id, owner_id) REFERENCES owners (cafe_id, id)
);

CREATE INDEX password_reset_tokens_owner_idx ON password_reset_tokens (cafe_id, owner_id);

CREATE TRIGGER owners_touch_updated_at BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE owners FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON owners TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY owner_by_email ON owners FOR SELECT TO cl_app
  USING (email = current_owner_email());

ALTER TABLE owner_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON owner_invites TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY invite_by_secret ON owner_invites FOR SELECT TO cl_app
  USING (token_hash = current_secret_hash());

ALTER TABLE owner_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON owner_sessions TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY session_by_secret ON owner_sessions FOR SELECT TO cl_app
  USING (token_hash = current_secret_hash());

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON password_reset_tokens TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY reset_by_secret ON password_reset_tokens FOR SELECT TO cl_app
  USING (token_hash = current_secret_hash());

-- Runtime privileges. Only the columns the app changes are updatable; owners are never deleted by the app yet.
GRANT SELECT, INSERT ON owners TO cl_app;
GRANT UPDATE (password_hash, password_changed_at) ON owners TO cl_app;
GRANT SELECT, INSERT ON owner_invites TO cl_app;
GRANT UPDATE (used_at) ON owner_invites TO cl_app;
GRANT SELECT, INSERT, DELETE ON owner_sessions TO cl_app;
GRANT UPDATE (last_seen_at) ON owner_sessions TO cl_app;
GRANT SELECT, INSERT, DELETE ON password_reset_tokens TO cl_app;
REVOKE ALL ON FUNCTION current_owner_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION current_secret_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_owner_email() TO cl_app;
GRANT EXECUTE ON FUNCTION current_secret_hash() TO cl_app;
