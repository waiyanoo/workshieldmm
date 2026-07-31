-- ===========================================================================
-- 0015_subscription_billing — pay for a plan, not just credit packs.
--
-- 0014 only handled one-off credit purchases, which left two gaps:
--   * no way for a company to pay the monthly plan fee (Pricing Plan §3), so a
--     plan could only be granted by hand by a Super Admin; and
--   * `grantMonthlyCredits` handed out bundled credits to anyone carrying a
--     plan name, paid or not — the plan column was set by an admin and nothing
--     ever checked that money had changed hands.
--
-- A plan is now a PAID PERIOD with an end date. Bundled credits are granted
-- only while a period is live, and a company whose period lapses falls back to
-- Free automatically. Annual billing is a discounted price for a 12-month
-- period (§6), not a different credit entitlement — an annual payer still
-- receives their bundled credits month by month.
-- ===========================================================================

-- --- Plan catalogue ----------------------------------------------------------
-- Prices live here rather than in code so they can be tuned against the
-- willingness-to-pay work §7 still lists as open.
CREATE TABLE plan_prices (
  plan             text PRIMARY KEY
                     CHECK (plan IN ('starter', 'growth', 'enterprise')),
  display_name     text NOT NULL,
  monthly_mmk      int  NOT NULL CHECK (monthly_mmk > 0),
  -- Annual is charged up front for 12 months at a discount (§6: 10-20%).
  annual_mmk       int  NOT NULL CHECK (annual_mmk > 0),
  monthly_credits  int  NOT NULL CHECK (monthly_credits >= 0),
  active           boolean NOT NULL DEFAULT true
);

-- Annual figures are 10 months' fee for 12 months ≈ 17% off, inside the §6 band.
INSERT INTO plan_prices (plan, display_name, monthly_mmk, annual_mmk, monthly_credits) VALUES
  ('starter', 'Starter',  49900,  499000, 100),
  ('growth',  'Growth',  149000, 1490000, 500);

-- --- Paid plan periods -------------------------------------------------------
CREATE TABLE company_plan_periods (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan              text NOT NULL,
  billing_cycle     text NOT NULL CHECK (billing_cycle IN ('monthly', 'annual')),
  starts_at         timestamptz NOT NULL DEFAULT now(),
  ends_at           timestamptz NOT NULL,
  payment_intent_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_plan_periods_span CHECK (ends_at > starts_at)
);
-- Serves both "does this company have a live period" (the grant sweep) and
-- "show me its billing history". Not a partial index on `ends_at > now()`:
-- now() is STABLE, not IMMUTABLE, so it cannot appear in an index predicate —
-- and a predicate fixed at build time would go stale as the clock moved anyway.
CREATE INDEX idx_plan_periods_company ON company_plan_periods(company_id, ends_at DESC);

-- --- Payment intents cover both kinds ----------------------------------------
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'credit_pack'
    CHECK (kind IN ('credit_pack', 'subscription')),
  ADD COLUMN IF NOT EXISTS plan text,
  ADD COLUMN IF NOT EXISTS billing_cycle text
    CHECK (billing_cycle IN ('monthly', 'annual')),
  ADD COLUMN IF NOT EXISTS period_months int;

-- A credit pack needs a package; a subscription needs a plan and a cycle.
-- Enforced here so a malformed intent cannot reach the reconciliation queue.
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_kind_fields CHECK (
    (kind = 'credit_pack'  AND package_key IS NOT NULL)
    OR
    (kind = 'subscription' AND plan IS NOT NULL AND billing_cycle IS NOT NULL
                           AND period_months IS NOT NULL AND period_months > 0)
  );

-- package_key only applies to credit packs now.
ALTER TABLE payment_intents ALTER COLUMN package_key DROP NOT NULL;

-- A subscription intent buys access, not credits, so `credits` may be zero.
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_credits_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_credits_check
  CHECK (credits >= 0);

-- --- RLS + grants for the new tables -----------------------------------------
ALTER TABLE plan_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_prices FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_prices_read ON plan_prices FOR SELECT USING (true);
CREATE POLICY plan_prices_write ON plan_prices FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE company_plan_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_plan_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY company_plan_periods_scope ON company_plan_periods
  USING (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON plan_prices TO hyper_app;
GRANT SELECT, INSERT, UPDATE ON company_plan_periods TO hyper_app;

-- --- Back-fill periods for plans already granted by hand ---------------------
-- Companies an admin put on a paying plan before billing existed keep it for a
-- month, so switching this on does not cut off anyone mid-use. After that they
-- renew through the payment flow like everyone else.
INSERT INTO company_plan_periods (company_id, plan, billing_cycle, ends_at)
SELECT id, plan, 'monthly', now() + interval '1 month'
  FROM companies
 WHERE plan IN ('starter', 'growth', 'enterprise');
