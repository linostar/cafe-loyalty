-- migration: expand
-- Announcing quiet-hour campaigns on wallet passes (plan Step 12b, AC 14): the worker announces each running campaign
-- to every card opted in to offers (AC 4) while the campaign's window is open, once per campaign and card, and to a
-- card at most once per day in the café's time zone. A pass shows the card's latest announced offer while that
-- campaign runs and the card stays opted in; the announcement is the only change that notifies (Apple: the offer
-- field's changeMessage, only on the day it was announced; Google: one TEXT_AND_NOTIFY message per pass), so a card
-- gets at most one notifying update a day.
--
-- An announcement, a campaign's end and a card opting in or out mark the card's current passes changed in the database
-- itself, as stamp changes do (migrations 0008, 0009): the announcing job queues their updates, and the sweep of
-- undelivered passes delivers the rest within 15 minutes. Deleting a card deletes its announcements (AC 9).
-- Runs as cl_owner with search_path = app.

CREATE TABLE campaign_announcements (
  cafe_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  card_id uuid NOT NULL,
  announced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, card_id),
  CONSTRAINT campaign_announcements_campaign_fkey FOREIGN KEY (cafe_id, campaign_id) REFERENCES campaigns (cafe_id, id),
  CONSTRAINT campaign_announcements_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE CASCADE
);

-- A card's latest announcement (the offer its passes show) and its announcements today (the daily cap).
CREATE INDEX campaign_announcements_card_idx ON campaign_announcements (card_id, announced_at DESC);

-- When a Google pass last had a notifying write, set before the write is attempted: a retry never notifies twice.
ALTER TABLE google_passes ADD COLUMN offer_notified_at timestamptz;

-- Marks the current passes (the card's epoch) of these cards changed. Runs as the caller, under its café.
CREATE FUNCTION touch_offer_passes(card_ids uuid[]) RETURNS void
  LANGUAGE sql
  SET search_path = app, pg_temp
  AS $$
  UPDATE apple_passes
     SET updated_xid = pg_current_xact_id(),
         modified_at = greatest(date_trunc('second', now()), apple_passes.modified_at + interval '1 second')
    FROM cards
   WHERE cards.id = apple_passes.card_id AND cards.epoch = apple_passes.epoch AND cards.id = ANY (card_ids);
  UPDATE google_passes
     SET updated_xid = pg_current_xact_id()
    FROM cards
   WHERE cards.id = google_passes.card_id AND cards.epoch = google_passes.epoch AND cards.id = ANY (card_ids);
  $$;

CREATE FUNCTION touch_announced_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  PERFORM touch_offer_passes(ARRAY(SELECT card_id FROM announced));
  RETURN NULL;
END
$$;

CREATE TRIGGER campaign_announcements_touch_passes AFTER INSERT ON campaign_announcements
  REFERENCING NEW TABLE AS announced
  FOR EACH STATEMENT EXECUTE FUNCTION touch_announced_passes();

-- An ended campaign leaves the passes showing it (touching cards announced a later one too changes nothing on them).
CREATE FUNCTION touch_ended_campaign_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  PERFORM touch_offer_passes(ARRAY(SELECT card_id FROM campaign_announcements WHERE campaign_id = NEW.id));
  RETURN NULL;
END
$$;

CREATE TRIGGER campaigns_touch_offer_passes AFTER UPDATE OF ended_at ON campaigns
  FOR EACH ROW WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL)
  EXECUTE FUNCTION touch_ended_campaign_passes();

-- Opting in shows the offer field, opting out removes it.
CREATE FUNCTION touch_opted_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  PERFORM touch_offer_passes(ARRAY[NEW.id]);
  RETURN NULL;
END
$$;

CREATE TRIGGER cards_touch_offer_passes AFTER UPDATE OF offers_opt_in_at ON cards
  FOR EACH ROW WHEN ((OLD.offers_opt_in_at IS NULL) IS DISTINCT FROM (NEW.offers_opt_in_at IS NULL))
  EXECUTE FUNCTION touch_opted_passes();

ALTER TABLE campaign_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON campaign_announcements TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- The worker's announcing job (every 5 minutes) reads the running campaigns of every café, which the app role cannot
-- see at once: like undelivered_passes (migration 0009), this function runs as cl_owner, which sees only running
-- campaigns and their cafés through the policies below, and returns ids only. It names the campaigns whose window is
-- open now, in each café's time zone, with at least min_minutes_left of it to go; each café's announcements are then
-- made inside withCafe.
CREATE POLICY announce_running ON campaigns FOR SELECT TO cl_owner USING (ended_at IS NULL);
CREATE POLICY announce_running ON cafes FOR SELECT TO cl_owner
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.cafe_id = cafes.id AND campaigns.ended_at IS NULL));

CREATE FUNCTION campaigns_to_announce(min_minutes_left integer)
  RETURNS TABLE (cafe_id uuid, campaign_id uuid)
  -- STRICT, as undelivered_passes; the filter repeats the policies' own, so a later cl_owner policy cannot widen it.
  LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
  SELECT campaigns.cafe_id, campaigns.id
    FROM campaigns
    JOIN cafes ON cafes.id = campaigns.cafe_id
   CROSS JOIN LATERAL (SELECT now() AT TIME ZONE cafes.time_zone AS at) AS cafe_local
   CROSS JOIN LATERAL (SELECT (extract(hour FROM cafe_local.at) * 60 + extract(minute FROM cafe_local.at))::int AS minute) AS local_minute
   WHERE campaigns.ended_at IS NULL
     AND extract(isodow FROM cafe_local.at)::smallint = ANY (campaigns.weekdays)
     AND local_minute.minute >= campaigns.starts_minute
     AND local_minute.minute + min_minutes_left <= campaigns.ends_minute
   ORDER BY campaigns.created_at
  $$;

-- Runtime privileges. Announcements go with their card (the foreign key's cascade) and are never changed.
GRANT SELECT, INSERT ON campaign_announcements TO cl_app;
GRANT UPDATE (offer_notified_at) ON google_passes TO cl_app;
REVOKE ALL ON FUNCTION touch_offer_passes(uuid[]) FROM PUBLIC;
-- Called from the triggers above as the caller; it only marks the passes of the caller's own café.
GRANT EXECUTE ON FUNCTION touch_offer_passes(uuid[]) TO cl_app;
REVOKE ALL ON FUNCTION touch_announced_passes() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_ended_campaign_passes() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_opted_passes() FROM PUBLIC;
REVOKE ALL ON FUNCTION campaigns_to_announce(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION campaigns_to_announce(integer) TO cl_app;
