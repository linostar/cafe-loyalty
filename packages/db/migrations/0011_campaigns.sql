-- migration: expand
-- Quiet-hour campaigns (plan Step 12, AC 35): an owner offers a discount on chosen order types at chosen hours of
-- chosen weekdays, in the café's time zone. A campaign is refused when an eligible order type's discounted price falls
-- below its cost plus the café's minimum margin (a percentage of cost), and the counter and the server check the same
-- again for every discounted line of a visit. Visit lines keep the discount and the campaign they used.
-- Runs as cl_owner with search_path = app.

-- The least a discounted price may be, as a percentage over cost: price * 100 >= cost * (100 + min_margin_percent).
ALTER TABLE cafes
  ADD COLUMN min_margin_percent integer NOT NULL DEFAULT 0 CHECK (min_margin_percent BETWEEN 0 AND 1000);

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cafe_id uuid NOT NULL REFERENCES cafes (id),
  name_ar text NOT NULL CHECK (char_length(name_ar) BETWEEN 1 AND 60),
  name_en text NOT NULL CHECK (char_length(name_en) BETWEEN 1 AND 60),
  -- ISO weekdays (1 = Monday) and local minutes of the day [starts_minute, ends_minute) the offer runs, in the café's
  -- time zone; a window never crosses midnight.
  weekdays smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  starts_minute integer NOT NULL CHECK (starts_minute BETWEEN 0 AND 1439),
  ends_minute integer NOT NULL CHECK (ends_minute BETWEEN 1 AND 1440),
  -- Percent off each unit (rounded down to the cent, in the café's favour) or a fixed amount off each unit, in cents.
  discount_kind text NOT NULL CHECK (discount_kind IN ('percent', 'amount')),
  discount_value integer NOT NULL,
  -- The café's minimum margin when the campaign was made: counters offline and the server check the same floor.
  min_margin_percent integer NOT NULL CHECK (min_margin_percent BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the owner ends it; a campaign is never edited, only ended and made again.
  ended_at timestamptz,
  CONSTRAINT campaigns_cafe_id_id_key UNIQUE (cafe_id, id),
  CONSTRAINT campaigns_window_check CHECK (starts_minute < ends_minute),
  CONSTRAINT campaigns_discount_check CHECK (
    (discount_kind = 'percent' AND discount_value BETWEEN 1 AND 100)
    OR (discount_kind = 'amount' AND discount_value BETWEEN 1 AND 100000000)
  ),
  CONSTRAINT campaigns_ended_check CHECK (ended_at IS NULL OR ended_at >= created_at)
);

CREATE INDEX campaigns_running_idx ON campaigns (cafe_id) WHERE ended_at IS NULL;

-- The order types a campaign discounts.
CREATE TABLE campaign_order_types (
  cafe_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  order_type_id uuid NOT NULL,
  PRIMARY KEY (campaign_id, order_type_id),
  CONSTRAINT campaign_order_types_campaign_fkey FOREIGN KEY (cafe_id, campaign_id) REFERENCES campaigns (cafe_id, id),
  CONSTRAINT campaign_order_types_order_type_fkey FOREIGN KEY (cafe_id, order_type_id) REFERENCES order_types (cafe_id, id)
);

-- A visit line's discount per unit and the campaign that gave it; lines without one keep 0 and null. The line's
-- unit_price_cents stays the list price, so the line's amount is quantity * (unit_price_cents - unit_discount_cents).
ALTER TABLE visit_items
  ADD COLUMN campaign_id uuid,
  ADD COLUMN unit_discount_cents integer NOT NULL DEFAULT 0 CHECK (unit_discount_cents BETWEEN 0 AND 100000000),
  ADD CONSTRAINT visit_items_campaign_fkey FOREIGN KEY (cafe_id, campaign_id) REFERENCES campaigns (cafe_id, id),
  ADD CONSTRAINT visit_items_discount_check CHECK (unit_discount_cents <= unit_price_cents AND (campaign_id IS NOT NULL OR unit_discount_cents = 0));

-- A visit whose discount its campaign did not allow at the visit's time (ended, not running then, another order type, a
-- different amount or below the margin floor) is held for the owner, like a late one: the customer paid the discounted
-- price at the counter, so the owner decides whether it counts, and the stamps are not lost meanwhile.
ALTER TABLE sync_events
  DROP CONSTRAINT sync_events_hold_reason_check,
  ADD CONSTRAINT sync_events_hold_reason_check CHECK (hold_reason IN ('device_revoked', 'staff_revoked', 'late_sync', 'campaign_check'));

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON campaigns TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

ALTER TABLE campaign_order_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_order_types FORCE ROW LEVEL SECURITY;
CREATE POLICY cafe_isolation ON campaign_order_types TO cl_app
  USING (cafe_id = current_cafe_id()) WITH CHECK (cafe_id = current_cafe_id());

-- Runtime privileges: campaigns are made and ended, never edited or deleted (cafes already has table-wide UPDATE).
GRANT SELECT, INSERT ON campaigns TO cl_app;
GRANT UPDATE (ended_at) ON campaigns TO cl_app;
GRANT SELECT, INSERT ON campaign_order_types TO cl_app;
