-- ===========================================================================
-- 0011_remove_notice_and_dispute — direct-publish model.
--
-- Product decision (July 2026): there is no pre-publication notice and no
-- dispute stage. The employer submits with evidence, a reviewer checks the
-- evidence, and acceptance publishes the report to other verified employers.
--
-- NOTE FOR WHOEVER READS THIS NEXT: this reverses a control that both
-- governing documents describe as structural, not optional — Revised Concept
-- §3.2 steps 4-5 and its stated central design principle ("paired with a right
-- of reply before it is ever visible to another employer"), and Technical Doc
-- §5 "Right of reply". Those documents are now out of step with the schema.
-- The remaining accuracy safeguards are the admin evidence gate and the
-- correction path (withdraw / correct a published report, audited with a
-- reason). Re-introducing the notice window means restoring the trigger and
-- the `notice_sent` / `disputed` states from 0009.
-- ===========================================================================

-- --- Retire the publication gate --------------------------------------------
DROP TRIGGER IF EXISTS trg_reports_notice_gate ON conduct_reports;
DROP FUNCTION IF EXISTS enforce_notice_before_approval();

-- --- Drain the in-flight states ---------------------------------------------
-- Reports mid-notice were already judged evidence-sufficient by a reviewer, so
-- under the new model they publish. Expiry is stamped here because nothing
-- else will do it for them.
UPDATE conduct_reports
   SET status      = 'approved',
       expiry_date = COALESCE(expiry_date, now() + interval '5 years')
 WHERE status = 'notice_sent';

-- Contested reports go back to the review queue rather than publishing on
-- their own: someone objected to these specifically, so a reviewer should make
-- the call with fresh eyes instead of the migration making it silently.
UPDATE conduct_reports
   SET status      = 'pending_review',
       expiry_date = NULL
 WHERE status = 'disputed';

-- --- Narrow the status vocabulary -------------------------------------------
ALTER TABLE conduct_reports DROP CONSTRAINT conduct_reports_status_check;
ALTER TABLE conduct_reports ADD CONSTRAINT conduct_reports_status_check
  CHECK (status IN ('draft', 'pending_review', 'approved', 'rejected',
                    'expired', 'withdrawn'));

-- --- Drop the notice/dispute machinery --------------------------------------
ALTER TABLE conduct_reports
  DROP COLUMN IF EXISTS notice_sent_at,
  DROP COLUMN IF EXISTS response_window_ends_at,
  DROP COLUMN IF EXISTS notice_token_hash;

-- `disputes` holds subject responses and `report_notices` holds the contact
-- addresses notices were sent to. Both are meaningless without the flow.
--
-- DESTRUCTIVE: this discards every response a reported person ever filed. On
-- the dev database that was 15 seeded fixtures. Before running this anywhere
-- with real data, export `disputes` first — those responses are the record of
-- someone contesting a claim about them, and there is no way to recover them
-- afterwards.
DROP TABLE IF EXISTS report_notices;
DROP TABLE IF EXISTS independent_review_board_cases CASCADE;
DROP TABLE IF EXISTS disputes CASCADE;
