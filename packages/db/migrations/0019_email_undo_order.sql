-- migration: expand
-- Orders a card's email undo links. email_change_seq counts the card's email changes (and undos), and each undo link
-- carries the count after the change it was sent for. Each undo adds to email_undo_voided the counts between its link's
-- and its own: those links were sent to addresses set after the one put back, so they stop working for good. The
-- address set first, whose link came first, keeps the card, whichever link is used first; each undo's range is kept on
-- its own (a multirange), so an earlier undo, such as of the holder's own typo, never stretches over a later incident's
-- links. Constant defaults and no CHECK, so adding the columns never scans cards. Runs as cl_owner with search_path = app.
ALTER TABLE cards
  ADD COLUMN email_change_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN email_undo_voided int4multirange NOT NULL DEFAULT '{}';

GRANT UPDATE (email_change_seq, email_undo_voided) ON cards TO cl_app;
