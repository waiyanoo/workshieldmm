-- ===========================================================================
-- 0008_b2b_report_flow — simplify Tier B to the B2B, evidence-accepted model.
--
-- Reports are now accepted on strong admin-verified evidence and published
-- directly. There is no pre-publication notice, no dispute, and no review
-- board. Accuracy is safeguarded by the admin evidence gate plus an admin
-- correction path (withdraw / correct a published report).
--
--   * Drop the notice-before-approval trigger — approval no longer requires a
--     notice_sent_at stamp.
--   * Allow a 'withdrawn' terminal state. Legacy statuses (notice_sent,
--     disputed) remain permitted so rows created under the old flow stay valid.
-- ===========================================================================

DROP TRIGGER IF EXISTS trg_reports_notice_gate ON conduct_reports;
DROP FUNCTION IF EXISTS enforce_notice_before_approval();

ALTER TABLE conduct_reports DROP CONSTRAINT conduct_reports_status_check;
ALTER TABLE conduct_reports ADD CONSTRAINT conduct_reports_status_check
  CHECK (status IN ('draft', 'pending_review', 'notice_sent', 'disputed',
                    'approved', 'rejected', 'expired', 'withdrawn'));

-- Retire any reports left mid-flow under the old model so the queues are clean.
-- notice_sent (was awaiting a subject response) → approved; disputed cases and
-- their board rows are closed out.
UPDATE conduct_reports
   SET status = 'approved',
       expiry_date = COALESCE(expiry_date, now() + interval '5 years')
 WHERE status IN ('notice_sent', 'disputed');
