-- migration: expand
-- Validates the holder name CHECK 0032 added NOT VALID: a scan under SHARE UPDATE EXCLUSIVE, which lets the running
-- release keep writing cards, in a transaction of its own.
-- Runs as cl_owner with search_path = app.

ALTER TABLE cards VALIDATE CONSTRAINT cards_holder_name_check;
