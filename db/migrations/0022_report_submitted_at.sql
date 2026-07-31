-- ===========================================================================
-- 0022_report_submitted_at — when a report entered the review queue.
--
-- `created_at` is when the employer opened the draft, which may be days before
-- they finish attaching evidence. Measuring reviewer turnaround from it charges
-- the review team for the employer's drafting time, so the reported figure gets
-- worse the longer customers take to write things up. `review_cases.decided_at`
-- already records the other end of the interval; this is the missing start.
-- ===========================================================================

ALTER TABLE conduct_reports
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz;

-- Anything already past draft was submitted at some point we did not record.
-- `created_at` is the only bound available and is the honest approximation:
-- it can only ever make historical turnaround look WORSE than it was, never
-- better, so the backfill cannot flatter the numbers.
UPDATE conduct_reports
   SET submitted_at = created_at
 WHERE status <> 'draft' AND submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_reports_submitted
  ON conduct_reports(submitted_at)
  WHERE status = 'pending_review';
