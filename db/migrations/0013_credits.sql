-- ===========================================================================
-- 0013_credits — plans and credit metering. (Pricing Plan §3, §4)
--
-- Monetization model: registration and report submission are free; the metered
-- actions are search, viewing a report, downloading evidence, and pulling the
-- full evidence pack. Plans differ only in how many credits they bundle, not in
-- what is unlocked (Pricing Plan §1).
--
-- Credits are held as LOTS, not a single balance column. Each grant is its own
-- lot with an expiry, spends consume lots earliest-expiry-first, and the sweep
-- expires whatever is left. That is what makes "unused credits roll over for up
-- to 3 months" (§4 Credit Rules) expressible at all — a single integer balance
-- cannot say which credits are about to lapse. It also keeps the whole thing
-- auditable: every movement is a ledger row.
-- ===========================================================================

-- --- Plan on the company -----------------------------------------------------
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'starter', 'growth', 'enterprise'));

-- Enterprise credit allowances are negotiated per contract (§3), so the monthly
-- grant is stored rather than derived from the plan name.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS monthly_credit_override int;

-- --- Credit lots -------------------------------------------------------------
CREATE TABLE credit_lots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  amount      int  NOT NULL CHECK (amount > 0),
  remaining   int  NOT NULL CHECK (remaining >= 0),
  reason      text NOT NULL
                CHECK (reason IN ('welcome', 'monthly_grant', 'purchase',
                                  'report_accepted', 'adjustment')),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  CONSTRAINT credit_lots_remaining_within_amount CHECK (remaining <= amount)
);
CREATE INDEX idx_credit_lots_company ON credit_lots(company_id);
-- The spend path reads exactly this: live lots, earliest expiry first.
CREATE INDEX idx_credit_lots_spendable ON credit_lots(company_id, expires_at)
  WHERE remaining > 0;

-- Only one monthly grant per company per calendar month, enforced in the data
-- layer so a retried or double-scheduled sweep cannot mint credits twice.
--
-- Pinned to UTC because date_trunc over a timestamptz is only STABLE — its
-- result depends on the session timezone — and an index expression has to be
-- IMMUTABLE. Converting to plain timestamp at UTC first makes it so, and also
-- means "which month" cannot change with the connection's timezone setting.
CREATE UNIQUE INDEX idx_credit_lots_one_grant_per_month
  ON credit_lots(company_id, date_trunc('month', granted_at AT TIME ZONE 'UTC'))
  WHERE reason = 'monthly_grant';

-- --- Ledger ------------------------------------------------------------------
-- Append-only record of every movement. Spends are negative and name the action
-- that caused them, so usage can be billed back and disputed.
CREATE TABLE credit_ledger (
  id            bigserial PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  delta         int  NOT NULL CHECK (delta <> 0),
  action        text NOT NULL,
  lot_id        uuid REFERENCES credit_lots(id) ON DELETE SET NULL,
  resource_type text,
  resource_id   uuid,
  actor_user_id uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_credit_ledger_company ON credit_ledger(company_id, created_at DESC);

-- --- RLS ---------------------------------------------------------------------
-- A company reads its own credit history; platform staff and the service-
-- internal context see everything. Writes never come from a company session
-- directly — they are made by the metering code inside the request that spends
-- them, which runs in the company's context, so INSERT is allowed for own rows.
ALTER TABLE credit_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_lots FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_lots_scope ON credit_lots
  USING (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id());

ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_scope ON credit_ledger
  USING (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON credit_lots TO hyper_app;
GRANT SELECT, INSERT ON credit_ledger TO hyper_app;
GRANT USAGE, SELECT ON SEQUENCE credit_ledger_id_seq TO hyper_app;

-- --- Welcome credits for companies that already exist ------------------------
-- Every Free-plan account starts with 10 welcome credits (§3). Existing
-- companies get theirs now so the dev/pilot data is consistent with new signups.
INSERT INTO credit_lots (company_id, amount, remaining, reason, expires_at)
SELECT id, 10, 10, 'welcome', now() + interval '3 months'
  FROM companies;

INSERT INTO credit_ledger (company_id, delta, action, metadata)
SELECT id, 10, 'grant.welcome', '{"backfilled": true}'::jsonb
  FROM companies;
