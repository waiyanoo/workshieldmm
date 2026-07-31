-- ===========================================================================
-- 0025_retire_legacy_report_categories
--
-- The product policy now uses the eight specific, evidence-based conduct
-- report reasons in 0024. Do not delete the earlier category rows: existing
-- reports reference them and must remain historically intelligible. Making
-- them ineligible prevents new reports while preserving that history.
-- ===========================================================================

UPDATE report_categories
   SET eligible = false,
       description = 'Retired category. Kept only for historical reports; not available for new reports.',
       evidence_requirements = 'N/A — retired category.',
       updated_at = now()
 WHERE key IN ('confirmed_theft', 'confirmed_fraud', 'serious_policy_breach');
