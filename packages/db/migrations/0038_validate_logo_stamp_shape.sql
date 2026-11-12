-- migration: expand
-- Validates the stamp shape CHECK 0037 added NOT VALID: a scan under SHARE UPDATE EXCLUSIVE, which lets the running
-- release keep writing cafés, in a transaction of its own.
-- Runs as cl_owner with search_path = app.

ALTER TABLE cafes VALIDATE CONSTRAINT cafes_stamp_shape_check;
