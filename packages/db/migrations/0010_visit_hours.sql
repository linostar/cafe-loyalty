-- migration: expand
-- Busy and quiet hours (plan Step 11): the owner dashboard counts a café's member visits of the last weeks by the
-- hour they happened in (occurred_at), so it reads them by café and time.
-- Runs as cl_owner with search_path = app.

CREATE INDEX visits_occurred_idx ON visits (cafe_id, occurred_at);
