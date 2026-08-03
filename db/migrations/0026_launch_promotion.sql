-- ===========================================================================
-- 0026_launch_promotion — a time-boxed discount on money prices.
--
-- The list prices in plan_prices and credit_packages are NOT changed. A
-- promotion is a separate fact with its own dates, applied when a payment
-- intent is created, and that separation buys three things:
--
--   * the screen can show "49,900" struck through next to "34,930", which is
--     the entire point of running a promotion;
--   * ending it is one row, not a re-pricing exercise with the risk of
--     restoring the wrong numbers a year later;
--   * a receipt can say what was discounted, so a customer who compares two
--     invoices six months apart is not left wondering.
--
-- Only MONEY is discounted. What an action costs in CREDITS is untouched — a
-- search is 5 credits before and during the promotion. Discounting both would
-- compound to a much larger giveaway than intended.
-- ===========================================================================

CREATE TABLE pricing_promotions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  -- Percentage taken OFF the list price. 30 means the customer pays 70%.
  percent_off  int  NOT NULL CHECK (percent_off > 0 AND percent_off < 100),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_window CHECK (ends_at > starts_at)
);

-- At most one promotion may be live at any instant. Two overlapping discounts
-- is not a pricing strategy, it is a question nobody can answer at the till.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE pricing_promotions
  ADD CONSTRAINT promo_no_overlap
  EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&)
  WHERE (active);

ALTER TABLE pricing_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_promotions FORCE ROW LEVEL SECURITY;
-- Readable by anyone with a session: buyers have to see the offer. Writable
-- only by platform staff.
CREATE POLICY promo_read ON pricing_promotions FOR SELECT USING (true);
CREATE POLICY promo_write ON pricing_promotions FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, UPDATE ON pricing_promotions TO hyper_app;

-- What a given payment actually had applied. Recorded on the intent alongside
-- the frozen amount, so the discount survives the promotion ending.
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS list_amount_mmk  int,
  ADD COLUMN IF NOT EXISTS discount_percent int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_id     uuid REFERENCES pricing_promotions(id);

-- Everything already taken was paid at list price.
UPDATE payment_intents SET list_amount_mmk = amount_mmk WHERE list_amount_mmk IS NULL;

COMMENT ON COLUMN payment_intents.list_amount_mmk IS
  'Undiscounted price at the time the intent was created. amount_mmk is what '
  'the customer actually pays.';

-- The launch offer: 30% off for twelve months.
--
-- The window starts NOW because the go-live date is not known at migration
-- time. Set the real one before launch — it is a single statement:
--
--   UPDATE pricing_promotions
--      SET starts_at = '2026-09-01', ends_at = '2027-09-01'
--    WHERE name = 'Launch offer';
--
-- To end it early: UPDATE pricing_promotions SET active = false WHERE ...
INSERT INTO pricing_promotions (name, percent_off, starts_at, ends_at)
VALUES ('Launch offer', 30, now(), now() + interval '1 year');
