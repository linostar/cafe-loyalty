-- migration: expand
-- A visit records whether its discount failed the campaign re-check (AC 35), whatever it was held for: a visit held
-- as late or from a removed phone or barista can fail it too, and the owner must see that before accepting it.
-- Runs as cl_owner with search_path = app.

ALTER TABLE visits ADD COLUMN discount_refused boolean NOT NULL DEFAULT false;
