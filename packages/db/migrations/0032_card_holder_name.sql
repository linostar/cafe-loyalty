-- migration: expand
-- The card holder's name, asked at signup (parseHolderName, shared): shown to the café's staff on the counter after a
-- scan, on the web card and on the wallet passes. Per card, never on the shared customers row (a number is not
-- verified, so it may not be the holder's own); deleted with the card. Cards made before have none (null); nothing
-- asks for one, and the name is never changed (no UPDATE grant: 0004's SELECT and INSERT cover it).
-- Runs as cl_owner with search_path = app.

ALTER TABLE cards ADD COLUMN holder_name text;

-- Added NOT VALID (no scan under this lock; new rows are checked at once) and validated by 0033 under a lock that lets
-- writes through. 1 to 60 characters, as parseHolderName allows.
ALTER TABLE cards
  ADD CONSTRAINT cards_holder_name_check CHECK (holder_name IS NULL OR char_length(holder_name) BETWEEN 1 AND 60) NOT VALID;
