-- ===========================================================================
-- 0018_credit_lifetimes — a lifetime per credit source.
--
-- Supersedes the flat "no rollover" rule from 0017. Credits now live for a
-- period that depends on where they came from (owner decision):
--
--   welcome          1 month   free starter allowance, meant to be used
--   monthly_grant    3 months  the plan allowance — rolls over, as Pricing
--                              Plan §4 originally specified
--   report_accepted  3 months  earned by supplying an accepted record; §4
--                              groups the reward with the subscription rule
--   purchase         6 months  paid for in cash, so it gets the longest life
--   adjustment       6 months  admin correction, treated like a purchase
--
-- Subscription credits rolling over for 3 months restores alignment with
-- Pricing Plan §4; the 1/6-month figures for welcome and purchased credits are
-- an owner decision the document does not cover.
--
-- Durations are mirrored in CREDIT_LIFETIME_MONTHS in credits.service.ts —
-- change both together.
-- ===========================================================================

-- Re-stamp every live lot from its grant date under the new rules. Lots whose
-- new expiry has already passed lapse on the next sweep, which is the intended
-- effect of shortening a window rather than a defect.
UPDATE credit_lots
   SET expires_at = granted_at + interval '1 month'
 WHERE reason = 'welcome' AND remaining > 0;

UPDATE credit_lots
   SET expires_at = granted_at + interval '3 months'
 WHERE reason IN ('monthly_grant', 'report_accepted') AND remaining > 0;

UPDATE credit_lots
   SET expires_at = granted_at + interval '6 months'
 WHERE reason IN ('purchase', 'adjustment') AND remaining > 0;
