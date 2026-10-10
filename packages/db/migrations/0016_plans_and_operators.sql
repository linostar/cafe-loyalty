-- migration: expand
-- Plans, payments and operators (plan Step 15, AC 39): the operator (who runs the service and creates cafés with
-- create-invite) signs in to the dashboard's admin screen with an operator account, sets each café's plan (pilot,
-- active, suspended) and records the payments the café made by hand. A suspended café's counter still syncs what it
-- queued, but its signup page enrols no one. Operators and their sessions belong to no café: like owners' sign-in,
-- they are found by email or session hash (withLookup), and changed only with the operator's own id set
-- (withOperator); a café's plan and payments are changed inside withCafe for that café, by an operator's request.
-- Runs as cl_owner with search_path = app.

-- New cafés start as pilots.
ALTER TABLE cafes
  ADD COLUMN plan text NOT NULL DEFAULT 'pilot' CHECK (plan IN ('pilot', 'active', 'suspended'));

-- Operators act on cafés too, so the audit log names them.
ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_actor_type_check,
  ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('owner', 'staff', 'device', 'system', 'operator'));

-- The operator a transaction acts for (withOperator), and the email being signed in with (withLookup).
CREATE FUNCTION current_operator_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.operator_id', true), '')::pg_catalog.uuid $$;
CREATE FUNCTION current_operator_email() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.operator_email', true), '') $$;

-- Created, and their password replaced, only by the create-operator command.
CREATE TABLE operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 1 AND 512),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operators_email_key UNIQUE (email)
);

CREATE TABLE operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id uuid NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT operator_sessions_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX operator_sessions_operator_idx ON operator_sessions (operator_id);

-- A payment the operator recorded for a café: what it paid, when, how, and an optional reference (a receipt or
-- transfer number, never personal data).
CREATE TABLE cafe_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  paid_on date NOT NULL,
  method text NOT NULL CHECK (method IN ('cash', 'whish', 'omt', 'bank_transfer', 'other')),
  reference text CHECK (char_length(reference) BETWEEN 1 AND 100),
  operator_id uuid NOT NULL REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cafe_payments_cafe_idx ON cafe_payments (cafe_id, paid_on DESC, created_at DESC);

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_by_email ON operators TO cl_app
  USING (email = current_operator_email() OR id = current_operator_id()) WITH CHECK (email = current_operator_email() OR id = current_operator_id());

ALTER TABLE operator_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_session_by_secret ON operator_sessions FOR SELECT TO cl_app
  USING (token_hash = current_secret_hash());
CREATE POLICY operator_session_own ON operator_sessions TO cl_app
  USING (operator_id = current_operator_id()) WITH CHECK (operator_id = current_operator_id());

ALTER TABLE cafe_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafe_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON cafe_payments TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- The admin screen lists every café, which the app role cannot: like cafes_for_feedback (migration 0015), this runs as
-- cl_owner and returns ids only; each café is then read inside withCafe, after the operator's session was checked.
CREATE FUNCTION cafes_for_operator()
  RETURNS TABLE (cafe_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
  SELECT id FROM cafes ORDER BY created_at, id
  $$;

-- Runtime privileges. Payments are recorded, never changed or deleted. The plan is set through the table-wide UPDATE
-- on cafes (migration 0001); only the admin routes write it.
GRANT SELECT, INSERT ON operators TO cl_app;
GRANT UPDATE (password_hash, password_changed_at) ON operators TO cl_app;
GRANT SELECT, INSERT, DELETE ON operator_sessions TO cl_app;
GRANT UPDATE (last_seen_at) ON operator_sessions TO cl_app;
GRANT SELECT, INSERT ON cafe_payments TO cl_app;
REVOKE ALL ON FUNCTION current_operator_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION current_operator_email() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_operator_id() TO cl_app;
GRANT EXECUTE ON FUNCTION current_operator_email() TO cl_app;
REVOKE ALL ON FUNCTION cafes_for_operator() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cafes_for_operator() TO cl_app;
