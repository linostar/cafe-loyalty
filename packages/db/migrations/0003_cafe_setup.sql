-- migration: expand
-- Café setup: staff and their PINs, counter devices with their signing keys and access tokens, and pairing codes.
-- Pairing and token renewal happen before the café is known. They read through SELECT-only policies keyed on what
-- the device holds: the hash of a pairing code's lookup part or of an access token (current_secret_hash()), or its
-- key id (current_device_key_id()). Every write still needs the café that withCafe sets.
-- Runs as cl_owner with search_path = app.

CREATE FUNCTION current_device_key_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.device_key_id', true), '')::pg_catalog.uuid $$;

-- Baristas. The PIN is kept only as PBKDF2-SHA256, which paired devices receive to check PINs offline (AC 19).
CREATE TABLE staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  pin_salt bytea NOT NULL CHECK (octet_length(pin_salt) = 16),
  pin_hash bytea NOT NULL CHECK (octet_length(pin_hash) = 32),
  pin_iterations integer NOT NULL CHECK (pin_iterations BETWEEN 100000 AND 10000000),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_cafe_id_id_key UNIQUE (cafe_id, id)
);

-- Counter phones.
CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  paired_at timestamptz NOT NULL DEFAULT now(),
  -- A device that has not renewed its token for 7 days must pair again (AC 18).
  last_renewed_at timestamptz NOT NULL DEFAULT now(),
  -- The issuedAt of the last accepted renewal; a renewal must be signed later, so a captured one cannot be replayed.
  last_renewal_issued_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_cafe_id_id_key UNIQUE (cafe_id, id)
);

-- A device's public signing keys. The id is the keyId its events carry; old keys stay, so events signed before
-- a re-pairing still verify.
CREATE TABLE device_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  device_id uuid NOT NULL,
  -- ECDSA P-256 public key as a JWK with kty, crv, x and y only.
  public_key jsonb NOT NULL CHECK (jsonb_typeof(public_key) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_keys_device_fkey FOREIGN KEY (cafe_id, device_id) REFERENCES devices (cafe_id, id)
);

CREATE INDEX device_keys_device_idx ON device_keys (cafe_id, device_id);

-- Short-lived device access tokens, stored as SHA-256 hashes.
CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  device_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT device_tokens_device_fkey FOREIGN KEY (cafe_id, device_id) REFERENCES devices (cafe_id, id)
);

CREATE INDEX device_tokens_device_idx ON device_tokens (cafe_id, device_id);

-- Single-use codes an owner creates to pair a device (AC 17). The code is a 4-character lookup part, which finds
-- the row, and an 8-character secret part (40 bits), which is checked; 5 wrong secrets delete the code.
CREATE TABLE pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 60),
  lookup_hash bytea NOT NULL CHECK (octet_length(lookup_hash) = 32),
  secret_hash bytea NOT NULL CHECK (octet_length(secret_hash) = 32),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pairing_codes_lookup_hash_key UNIQUE (lookup_hash),
  CONSTRAINT pairing_codes_owner_fkey FOREIGN KEY (cafe_id, owner_id) REFERENCES owners (cafe_id, id)
);

CREATE INDEX pairing_codes_owner_idx ON pairing_codes (cafe_id, owner_id);

CREATE TRIGGER staff_touch_updated_at BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON staff TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON devices TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE device_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON device_keys TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY device_key_by_id ON device_keys FOR SELECT TO cl_app
  USING (id = current_device_key_id());

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON device_tokens TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY device_token_by_secret ON device_tokens FOR SELECT TO cl_app
  USING (token_hash = current_secret_hash());

ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON pairing_codes TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY pairing_code_by_secret ON pairing_codes FOR SELECT TO cl_app
  USING (lookup_hash = current_secret_hash());

-- Runtime privileges. Staff and devices are revoked, never deleted, so their past actions keep their names.
GRANT SELECT, INSERT ON staff TO cl_app;
GRANT UPDATE (name, pin_salt, pin_hash, pin_iterations, revoked_at) ON staff TO cl_app;
GRANT SELECT, INSERT ON devices TO cl_app;
GRANT UPDATE (last_renewed_at, last_renewal_issued_at, last_seen_at, revoked_at) ON devices TO cl_app;
GRANT SELECT, INSERT ON device_keys TO cl_app;
GRANT SELECT, INSERT, DELETE ON device_tokens TO cl_app;
GRANT SELECT, INSERT, DELETE ON pairing_codes TO cl_app;
GRANT UPDATE (failed_attempts) ON pairing_codes TO cl_app;
REVOKE ALL ON FUNCTION current_device_key_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_device_key_id() TO cl_app;
