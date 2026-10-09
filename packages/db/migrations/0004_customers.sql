-- migration: expand
-- Customers and their loyalty cards (plan Step 7).
--
-- A customer is a phone number, kept as an HMAC lookup hash and AES-GCM ciphertext (AC 6), with no café of its own:
-- a café reaches a customer only through its own cards (AC 3). Phone numbers are not verified, so everything a card
-- holder can act on (recovery email, consent, deletion) lives on the card, never on the shared customer row.
--
-- Signup, the web card page and recovery happen before any café is known. They read through SELECT-only policies
-- keyed on what the visitor holds: the café's join code, the card's web secret, a recovery email or token, or the
-- phone number, each as a SHA-256 or HMAC hash in current_secret_hash(). Writes to café tables still need withCafe.
-- Runs as cl_owner with search_path = app.

CREATE FUNCTION current_customer_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.customer_id', true), '')::pg_catalog.uuid $$;

-- The code in the café's printed signup QR (a public identifier, not a secret). A volatile default gives every
-- existing café its own code.
ALTER TABLE cafes
  ADD COLUMN join_code text NOT NULL DEFAULT pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
    CHECK (join_code ~ '^[0-9a-f]{32}$'),
  -- decode(..., 'escape') is immutable, as a generated column needs (convert_to is not); for a code of hex digits
  -- it gives the same bytes as the UTF-8 the server hashes.
  ADD COLUMN join_code_hash bytea GENERATED ALWAYS AS (pg_catalog.sha256(pg_catalog.decode(join_code, 'escape'))) STORED;

ALTER TABLE cafes ADD CONSTRAINT cafes_join_code_key UNIQUE (join_code);

CREATE POLICY cafe_by_join_code ON cafes FOR SELECT TO cl_app
  USING (join_code_hash = current_secret_hash());

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- HMAC-SHA256 of the E.164 number with a secret pepper.
  phone_lookup bytea NOT NULL CHECK (octet_length(phone_lookup) = 32),
  -- AES-256-GCM: 12-byte IV, 16-byte tag, then the ciphertext; phone_key_id names the key.
  phone_ciphertext bytea NOT NULL CHECK (octet_length(phone_ciphertext) BETWEEN 29 AND 64),
  phone_key_id text NOT NULL CHECK (phone_key_id ~ '^[a-z0-9]{1,16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_phone_lookup_key UNIQUE (phone_lookup)
);

CREATE TABLE cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  -- Null for a card whose number already had a card at this café (AC 5): it works by QR, never by phone number.
  -- RESTRICT: a customer row can only be deleted once no café has a card for it.
  customer_id uuid REFERENCES customers (id) ON DELETE RESTRICT,
  -- Bumped by recovery: QR codes and web links from earlier epochs stop working (AC 8).
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  -- SHA-256 of the web card link's 256-bit secret (AC 7).
  web_secret_hash bytea NOT NULL CHECK (octet_length(web_secret_hash) = 32),
  stamps integer NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  -- When the customer accepted the privacy notice, and when (if ever) they opted in to offers (AC 4).
  privacy_accepted_at timestamptz NOT NULL,
  offers_opt_in_at timestamptz,
  -- Optional recovery email (AC 8), with its HMAC for lookup.
  email text CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  email_lookup bytea CHECK (octet_length(email_lookup) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cards_web_secret_hash_key UNIQUE (web_secret_hash),
  CONSTRAINT cards_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT cards_email_pair CHECK ((email IS NULL) = (email_lookup IS NULL))
);

-- One phone-linked card per customer per café.
CREATE UNIQUE INDEX cards_cafe_customer_key ON cards (cafe_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX cards_customer_idx ON cards (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX cards_email_lookup_idx ON cards (email_lookup) WHERE email_lookup IS NOT NULL;

-- Single-use recovery links (AC 8): one per email, so a new request replaces the old link even when two race.
CREATE TABLE customer_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_lookup bytea NOT NULL CHECK (octet_length(email_lookup) = 32),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_recovery_tokens_email_lookup_key UNIQUE (email_lookup),
  CONSTRAINT customer_recovery_tokens_token_hash_key UNIQUE (token_hash)
);

CREATE TRIGGER cards_touch_updated_at BEFORE UPDATE ON cards
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON cards TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());
CREATE POLICY card_by_secret ON cards FOR SELECT TO cl_app
  USING (web_secret_hash = current_secret_hash() OR email_lookup = current_secret_hash());

-- Customers have no café: a café sees a customer only through one of its own cards (AC 3). The other policies
-- each need what the caller holds: the phone's hash (signup) or the customer's id (removing one left without cards).
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_through_card ON customers FOR SELECT TO cl_app
  USING (EXISTS (SELECT 1 FROM cards WHERE cards.customer_id = customers.id));
CREATE POLICY customer_by_phone ON customers FOR SELECT TO cl_app
  USING (phone_lookup = current_secret_hash());
CREATE POLICY customer_insert_by_phone ON customers FOR INSERT TO cl_app
  WITH CHECK (phone_lookup = current_secret_hash());
CREATE POLICY customer_by_id ON customers FOR SELECT TO cl_app
  USING (id = current_customer_id());
-- The ON DELETE RESTRICT foreign key from cards (checked regardless of row-level security) refuses this while any
-- café still has a card for the customer.
CREATE POLICY customer_delete_by_id ON customers FOR DELETE TO cl_app
  USING (id = current_customer_id());

ALTER TABLE customer_recovery_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_recovery_tokens FORCE ROW LEVEL SECURITY;
-- Holding the link's token lets one read and use it (delete it), never create one.
CREATE POLICY recovery_by_token ON customer_recovery_tokens FOR SELECT TO cl_app
  USING (token_hash = current_secret_hash());
CREATE POLICY recovery_use_by_token ON customer_recovery_tokens FOR DELETE TO cl_app
  USING (token_hash = current_secret_hash());
CREATE POLICY recovery_by_email ON customer_recovery_tokens TO cl_app
  USING (email_lookup = current_secret_hash()) WITH CHECK (email_lookup = current_secret_hash());

-- Runtime privileges. Customers are never updated (a key rotation re-encrypts in a migration).
GRANT SELECT, INSERT, DELETE ON customers TO cl_app;
GRANT SELECT, INSERT, DELETE ON cards TO cl_app;
GRANT UPDATE (epoch, web_secret_hash, offers_opt_in_at, email, email_lookup) ON cards TO cl_app;
GRANT SELECT, INSERT, DELETE ON customer_recovery_tokens TO cl_app;
GRANT UPDATE (token_hash, expires_at) ON customer_recovery_tokens TO cl_app;
REVOKE ALL ON FUNCTION current_customer_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_customer_id() TO cl_app;
