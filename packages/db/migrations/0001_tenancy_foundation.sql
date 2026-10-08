-- migration: expand
-- Tenancy foundation: cafés, loyalty programs, order types and the audit log.
-- Every table in schema app is scoped to one café by row-level security. The café comes from
-- current_cafe_id(), which reads the transaction-local setting app.cafe_id that withCafe sets.
-- Runs as cl_owner with search_path = app.

CREATE FUNCTION current_cafe_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.cafe_id', true), '')::uuid $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TABLE cafes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  time_zone text NOT NULL DEFAULT 'Asia/Beirut' CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  -- Bumped whenever an order type's price or cost changes; visits record the version they were priced at.
  catalog_version integer NOT NULL DEFAULT 1 CHECK (catalog_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  stamps_required integer NOT NULL CHECK (stamps_required BETWEEN 1 AND 50),
  reward_name_ar text NOT NULL CHECK (char_length(reward_name_ar) BETWEEN 1 AND 80),
  reward_name_en text NOT NULL CHECK (char_length(reward_name_en) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One program per café in this version.
  CONSTRAINT loyalty_programs_one_per_cafe UNIQUE (cafe_id),
  -- Lets child tables reference (cafe_id, id) so a row can never point at another café's program.
  CONSTRAINT loyalty_programs_cafe_id_id_key UNIQUE (cafe_id, id)
);

CREATE TABLE order_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  name_ar text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 60),
  name_en text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 60),
  -- USD in integer cents, the same range as the shared centsSchema (0 to 100,000,000).
  price_cents integer NOT NULL CHECK (price_cents BETWEEN 0 AND 100000000),
  cost_cents integer NOT NULL CHECK (cost_cents BETWEEN 0 AND 100000000),
  stamps_earned integer NOT NULL DEFAULT 1 CHECK (stamps_earned BETWEEN 0 AND 10),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_types_cafe_id_id_key UNIQUE (cafe_id, id)
);

CREATE INDEX order_types_cafe_sort_idx ON order_types (cafe_id, sort_order);

CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  actor_type text NOT NULL CHECK (actor_type IN ('owner', 'staff', 'device', 'system')),
  actor_id uuid,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 64),
  entity_type text NOT NULL CHECK (char_length(entity_type) BETWEEN 1 AND 64),
  entity_id uuid,
  -- What changed, without personal data.
  changes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_cafe_time_idx ON audit_log (cafe_id, occurred_at DESC);

CREATE TRIGGER cafes_touch_updated_at BEFORE UPDATE ON cafes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER loyalty_programs_touch_updated_at BEFORE UPDATE ON loyalty_programs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER order_types_touch_updated_at BEFORE UPDATE ON order_types
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Row-level security, forced so that it applies to the table owner as well.
ALTER TABLE cafes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafes FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON cafes TO cl_app
  USING (id = current_cafe_id()) WITH CHECK (id = current_cafe_id());

ALTER TABLE loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_programs FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON loyalty_programs TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE order_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_types FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON order_types TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON audit_log TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- Runtime privileges. Cafés are never deleted by the app; the audit log is append-only.
GRANT SELECT, INSERT, UPDATE ON cafes TO cl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON loyalty_programs, order_types TO cl_app;
GRANT SELECT, INSERT ON audit_log TO cl_app;
REVOKE ALL ON FUNCTION current_cafe_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_cafe_id() TO cl_app;
REVOKE ALL ON FUNCTION touch_updated_at() FROM PUBLIC;
