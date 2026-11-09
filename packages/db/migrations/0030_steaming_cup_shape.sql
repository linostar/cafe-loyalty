-- migration: expand
-- One more stamp shape: a steaming cup ('steamcup', beside 'cup'). A new shape is a new stamp picture address, so no
-- pass layout changes. A release from before this one cannot draw it: before rolling back past it, move any café on
-- it to an older shape (README, Card branding).
-- Runs as cl_owner with search_path = app.

-- Widens 0027's CHECK. Added NOT VALID (no scan under this lock; new and changed rows are checked at once) and
-- validated by 0031 under a lock that lets writes through.
ALTER TABLE cafes DROP CONSTRAINT cafes_stamp_shape_check;
ALTER TABLE cafes
  ADD CONSTRAINT cafes_stamp_shape_check CHECK (stamp_shape IN ('circle', 'cup', 'steamcup', 'plate', 'bean', 'icecream', 'cake', 'burger')) NOT VALID;
