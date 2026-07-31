-- ===========================================================================
-- 0016_system_company_billing_write — let the scheduled sweep downgrade plans.
--
-- 0004 gave `companies` a write policy admitting platform staff or the company
-- itself; 0007 added a SELECT path for the service-internal 'system' context.
-- Nothing could UPDATE as 'system', so `lapseExpiredPlans` — which runs in the
-- worker with no human behind it — matched zero rows and silently left lapsed
-- subscriptions on their paid plan forever. RLS was doing its job; the policy
-- simply had no route for the billing sweep.
--
-- Scope is deliberately narrow: the system context may change ONLY the billing
-- columns, and only in the downgrade direction. It cannot verify a company,
-- suspend one, or rename it — those stay human decisions behind the admin API.
-- ===========================================================================

CREATE POLICY companies_system_billing ON companies FOR UPDATE
  USING (app_user_type() = 'system')
  WITH CHECK (
    app_user_type() = 'system'
    -- The sweep only ever moves a company DOWN to free. Anything else — a
    -- status change, an upgrade — is refused at the data layer even if the
    -- application code is wrong.
    AND plan = 'free'
    AND monthly_credit_override IS NULL
  );
