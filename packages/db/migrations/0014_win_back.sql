-- migration: expand
-- Win-back offers (plan Step 13, AC 36): a card with at least 3 member visits lapses once the time since its last visit
-- exceeds the larger of twice its median gap between visits or 14 days. The worker records each lapse once (per card
-- and last visit) and, when the café has a win-back discount and the card is opted in to offers (AC 4), gives it the
-- offer: the café's discount on the card's next visit, for 14 days, at most once per the café's cool-down period, and
-- announced on the card's passes under AC 14's one notifying update per card per day, shared with campaign
-- announcements (migration 0013). The counter applies the discount when the barista says the card shows the offer, and
-- the server checks it again at sync, as for campaigns (AC 35): a visit whose win-back discount the card's offer does
-- not allow is held for the owner. A visit that gives the discount uses the offer up, held or not: the customer had it.
-- Runs as cl_owner with search_path = app.

-- The café's win-back discount (null: no offer, lapses are still recorded) and its cool-down in days, at least the 14
-- days an offer lasts.
ALTER TABLE cafes
  ADD COLUMN win_back_discount_kind text CHECK (win_back_discount_kind IN ('percent', 'amount')),
  ADD COLUMN win_back_discount_value integer,
  ADD COLUMN win_back_cooldown_days integer NOT NULL DEFAULT 30 CHECK (win_back_cooldown_days BETWEEN 14 AND 365),
  ADD CONSTRAINT cafes_win_back_discount_check CHECK (
    (win_back_discount_kind IS NULL AND win_back_discount_value IS NULL)
    OR (win_back_discount_kind = 'percent' AND win_back_discount_value BETWEEN 1 AND 100)
    OR (win_back_discount_kind = 'amount' AND win_back_discount_value BETWEEN 1 AND 100000000)
  );

CREATE TABLE card_lapses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL,
  card_id uuid NOT NULL,
  -- The card's last member visit when it lapsed: one lapse per card and last visit.
  last_visit_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The offer it got, with the café's terms and minimum margin at the time; all null without one.
  discount_kind text CHECK (discount_kind IN ('percent', 'amount')),
  discount_value integer,
  min_margin_percent integer CHECK (min_margin_percent BETWEEN 0 AND 1000),
  expires_at timestamptz,
  -- When the offer left the card's passes (used or expired), and the visit that used it.
  closed_at timestamptz,
  used_visit_id uuid,
  CONSTRAINT card_lapses_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT card_lapses_card_visit_key UNIQUE (card_id, last_visit_at),
  CONSTRAINT card_lapses_used_visit_key UNIQUE (used_visit_id),
  CONSTRAINT card_lapses_offer_check CHECK (
    (discount_kind IS NULL AND discount_value IS NULL AND min_margin_percent IS NULL AND expires_at IS NULL AND closed_at IS NULL AND used_visit_id IS NULL)
    OR (discount_kind = 'percent' AND discount_value BETWEEN 1 AND 100 AND min_margin_percent IS NOT NULL AND expires_at > created_at)
    OR (discount_kind = 'amount' AND discount_value BETWEEN 1 AND 100000000 AND min_margin_percent IS NOT NULL AND expires_at > created_at)
  ),
  CONSTRAINT card_lapses_card_fkey FOREIGN KEY (cafe_id, card_id) REFERENCES cards (cafe_id, id) ON DELETE CASCADE,
  CONSTRAINT card_lapses_used_visit_fkey FOREIGN KEY (cafe_id, used_visit_id) REFERENCES visits (cafe_id, id)
);

-- A card's offers, newest first: the one its passes show, the cool-down and the daily cap.
CREATE INDEX card_lapses_offer_idx ON card_lapses (card_id, created_at DESC) WHERE discount_kind IS NOT NULL;

-- A line discounted by the card's win-back offer; such a line has no campaign.
ALTER TABLE visit_items
  ADD COLUMN win_back boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT visit_items_discount_check,
  ADD CONSTRAINT visit_items_discount_check CHECK (
    unit_discount_cents <= unit_price_cents
    AND (campaign_id IS NOT NULL OR win_back OR unit_discount_cents = 0)
    AND NOT (win_back AND campaign_id IS NOT NULL)
  );

-- An offer given marks the card's current passes changed (touch_offer_passes, migration 0013), and so does one
-- leaving them, used or expired. Run as the caller, under its café.
CREATE FUNCTION touch_offered_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  PERFORM touch_offer_passes(ARRAY(SELECT card_id FROM lapsed WHERE discount_kind IS NOT NULL));
  RETURN NULL;
END
$$;

CREATE TRIGGER card_lapses_touch_passes AFTER INSERT ON card_lapses
  REFERENCING NEW TABLE AS lapsed
  FOR EACH STATEMENT EXECUTE FUNCTION touch_offered_passes();

CREATE FUNCTION touch_closed_offer_passes() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = app, pg_temp
  AS $$
BEGIN
  PERFORM touch_offer_passes(ARRAY[NEW.card_id]);
  RETURN NULL;
END
$$;

CREATE TRIGGER card_lapses_touch_closed_passes AFTER UPDATE OF closed_at ON card_lapses
  FOR EACH ROW WHEN (OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL)
  EXECUTE FUNCTION touch_closed_offer_passes();

ALTER TABLE card_lapses ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_lapses FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON card_lapses TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- The worker's win-back job (hourly) visits every café, which the app role cannot list: like campaigns_to_announce
-- (migration 0013), this function runs as cl_owner and returns ids only, each with whether the café's local time is
-- within the delivery hours [from_hour, to_hour) (new offers go out only then; expired ones close at any hour). Each
-- café's work is then done inside withCafe. The policy lets cl_owner read cafés, nothing else.
CREATE POLICY win_back_cafes ON cafes FOR SELECT TO cl_owner USING (true);

CREATE FUNCTION cafes_for_win_back(from_hour integer, to_hour integer)
  RETURNS TABLE (cafe_id uuid, in_hours boolean)
  LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = app, pg_temp
  AS $$
  SELECT id,
         extract(hour FROM now() AT TIME ZONE time_zone) >= from_hour AND extract(hour FROM now() AT TIME ZONE time_zone) < to_hour
    FROM cafes
   ORDER BY created_at, id
  $$;

-- Runtime privileges. Lapses go with their card (the foreign key's cascade); an offer is closed and used, never edited.
GRANT SELECT, INSERT ON card_lapses TO cl_app;
GRANT UPDATE (closed_at, used_visit_id) ON card_lapses TO cl_app;
REVOKE ALL ON FUNCTION touch_offered_passes() FROM PUBLIC;
REVOKE ALL ON FUNCTION touch_closed_offer_passes() FROM PUBLIC;
REVOKE ALL ON FUNCTION cafes_for_win_back(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cafes_for_win_back(integer, integer) TO cl_app;
