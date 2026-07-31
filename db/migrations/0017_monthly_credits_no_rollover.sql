-- ===========================================================================
-- 0017_monthly_credits_no_rollover — plan credits reset every month, and a
-- withdrawn report stays withdrawn.
--
-- Two owner decisions:
--
-- 1. NO ROLLOVER. Pricing Plan §4 says "unused monthly credits roll over for
--    up to 3 months"; the decision is that a plan's monthly allowance is
--    use-it-or-lose-it and expires at the end of the calendar month it was
--    granted in. The pricing document is now out of step with the code on this
--    point, deliberately.
--
--    Scope: the monthly allowance and the free welcome credits. Credits a
--    company BOUGHT, or EARNED by having a report accepted, are not a monthly
--    allowance — expiring those at month end would mean a 1000-credit pack
--    bought on the 28th mostly evaporating in three days. Those keep a 12-month
--    life. If they should also reset monthly, change PURCHASED_CREDIT_MONTHS in
--    credits.service.ts and re-run the backfill below.
--
-- 2. WITHDRAWAL IS FINAL. Already true in the application state machine; the
--    trigger below makes it a data-layer rule so no future code path can
--    resurrect a retracted report. Re-publishing means filing again, with
--    evidence, through review.
-- ===========================================================================

-- --- Existing allowance lots reset to end-of-month ---------------------------
-- Anything already past that point lapses on the next sweep, which is the
-- intended behaviour of the new rule rather than a data loss bug.
UPDATE credit_lots
   SET expires_at = date_trunc('month', granted_at AT TIME ZONE 'UTC')
                    + interval '1 month'
 WHERE reason IN ('monthly_grant', 'welcome')
   AND remaining > 0;

-- --- Withdrawal is terminal --------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_withdrawn_is_final()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'withdrawn' AND NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION
      'report % was withdrawn and cannot be returned to %; file a new report instead',
      OLD.id, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_withdrawn_final
  BEFORE UPDATE OF status ON conduct_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_withdrawn_is_final();
