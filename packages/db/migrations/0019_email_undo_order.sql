-- migration: expand
-- Orders a card's email undo links. email_change_seq counts the card's email changes (and undos), and each undo link
-- carries the count after the change it was sent for. An undo records the lowest link count any undo used
-- (email_undo_floor, never raised) and the count after itself (email_undo_seq): links from changes in between were sent
-- to addresses set after the one put back, so they stop working, and stay stopped. The address set first, whose link
-- came first, therefore keeps the card. Runs as cl_owner with search_path = app.
ALTER TABLE cards
  ADD COLUMN email_change_seq integer NOT NULL DEFAULT 0 CHECK (email_change_seq >= 0),
  ADD COLUMN email_undo_floor integer,
  ADD COLUMN email_undo_seq integer,
  ADD CONSTRAINT cards_email_undo_pair CHECK ((email_undo_floor IS NULL) = (email_undo_seq IS NULL) AND email_undo_floor < email_undo_seq);

GRANT UPDATE (email_change_seq, email_undo_floor, email_undo_seq) ON cards TO cl_app;
