-- migration: expand
-- Voiding a payment recorded by mistake: payments stay append-only (cafe_payments keeps SELECT and INSERT only), and a
-- void is its own insert-only row, keyed on the payment so a payment is voided at most once, with the operator, when
-- and why. A voided payment stays listed on the admin screen, struck through, and no longer counts toward what the
-- café paid. The composite key keeps a void on a payment of its own café. Runs as cl_owner with search_path = app.

ALTER TABLE cafe_payments ADD CONSTRAINT cafe_payments_cafe_id_id_key UNIQUE (cafe_id, id);

CREATE TABLE cafe_payment_voids (
  payment_id uuid PRIMARY KEY,
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  -- The operator's own words (such as "wrong amount"), never personal data; kept out of the audit log and the logs.
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 200),
  operator_id uuid NOT NULL REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cafe_payment_voids_payment_fkey FOREIGN KEY (cafe_id, payment_id) REFERENCES cafe_payments (cafe_id, id)
);

ALTER TABLE cafe_payment_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE cafe_payment_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON cafe_payment_voids TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

GRANT SELECT, INSERT ON cafe_payment_voids TO cl_app;
