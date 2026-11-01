-- migration: expand
-- The owner's first-run setup (D1, D22): when the setup wizard was finished or its rest skipped (it is then shown on
-- no device again), and when the customer signup QR was first printed (an item of Home's setup checklist). Both keep
-- the first time; null until then. The rest of the checklist is read from the café's own rows.
ALTER TABLE cafes ADD COLUMN setup_finished_at timestamptz;
ALTER TABLE cafes ADD COLUMN signup_qr_printed_at timestamptz;

-- Cafés already set up before the wizard existed (a loyalty program saved) are not taken through it: their checklist
-- shows what is left. RLS is forced, so the backfill needs policies of its own, dropped again below.
CREATE POLICY setup_backfill ON cafes FOR UPDATE TO cl_owner USING (true);
CREATE POLICY setup_backfill_read ON cafes FOR SELECT TO cl_owner USING (true);
CREATE POLICY setup_backfill ON loyalty_programs FOR SELECT TO cl_owner USING (true);
UPDATE cafes SET setup_finished_at = now() WHERE EXISTS (SELECT 1 FROM loyalty_programs WHERE loyalty_programs.cafe_id = cafes.id);
DROP POLICY setup_backfill ON cafes;
DROP POLICY setup_backfill_read ON cafes;
DROP POLICY setup_backfill ON loyalty_programs;
