-- migration: expand
-- Feedback (plan Step 14, AC 37): about 2 hours after a member visit, the worker gives the card a feedback request,
-- which puts a link on the card's passes and web card (silently: AC 14's one notifying update a day is kept for
-- offers). The link opens a page offering every customer both a private message to the owner and the café's Google
-- review link, with no review gating: no rating is asked, and both are shown to everyone. A message lands in the
-- owner's inbox. Requests and messages go with their card (AC 9). The link is signed, not stored (feedbackLink in the
-- db package), so the server and the worker both build it from the request's id.
-- Runs as cl_owner with search_path = app.

-- The café's Google review link (a "write a review" link from its Google Business Profile), or null for none.
ALTER TABLE cafes
  ADD COLUMN google_review_url text CHECK (google_review_url IS NULL OR (google_review_url LIKE 'https://%' AND length(google_review_url) <= 500));

-- One per visit asked about: the card's passes show its latest.
CREATE TABLE feedback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  card_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feedback_requests_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT feedback_requests_visit_key UNIQUE (visit_id),
  CONSTRAINT feedback_requests_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE CASCADE,
  CONSTRAINT feedback_requests_visit_fkey FOREIGN KEY (cafe_id, visit_id) REFERENCES visits (cafe_id, id)
);

-- A card's latest request (its passes' link) and the daily limit per card.
CREATE INDEX feedback_requests_card_idx ON feedback_requests (card_id, created_at DESC);

-- A customer's private message, at most one per request; the owner marks it read.
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  request_id uuid NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT feedback_request_key UNIQUE (request_id),
  CONSTRAINT feedback_request_fkey FOREIGN KEY (cafe_id, request_id) REFERENCES feedback_requests (cafe_id, id) ON DELETE CASCADE
);

-- The inbox, newest first.
CREATE INDEX feedback_inbox_idx ON feedback (cafe_id, created_at DESC, id DESC);

-- A request puts its link on the card's current passes (touch_offer_passes, migration 0013, marks them changed).
CREATE FUNCTION touch_feedback_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  PERFORM touch_offer_passes(ARRAY(SELECT card_id FROM requested));
  RETURN NULL;
END
$$;

CREATE TRIGGER feedback_requests_touch_passes AFTER INSERT ON feedback_requests
  REFERENCING NEW TABLE AS requested
  FOR EACH STATEMENT EXECUTE FUNCTION touch_feedback_passes();

ALTER TABLE feedback_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON feedback_requests TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON feedback TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- The worker's feedback job visits every café, which the app role cannot list: like cafes_for_win_back (migration
-- 0014, whose policy lets cl_owner read cafés), this runs as cl_owner and returns ids only; each café's work is then
-- done inside withCafe.
CREATE FUNCTION cafes_for_feedback()
  RETURNS TABLE (cafe_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
  SELECT id FROM cafes ORDER BY created_at, id
  $$;

-- Runtime privileges. Requests are never changed; a message is sent once and only marked read. Both go with their
-- card (the foreign keys' cascades).
GRANT SELECT, INSERT ON feedback_requests TO cl_app;
GRANT SELECT, INSERT ON feedback TO cl_app;
GRANT UPDATE (read_at) ON feedback TO cl_app;
REVOKE ALL ON FUNCTION touch_feedback_passes() FROM PUBLIC;
REVOKE ALL ON FUNCTION cafes_for_feedback() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cafes_for_feedback() TO cl_app;
