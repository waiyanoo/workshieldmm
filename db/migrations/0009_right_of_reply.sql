-- ===========================================================================
-- 0009_right_of_reply — restore the pre-publication notice and right of reply.
--
-- This reverses 0008, which had simplified Tier B to a direct-publish B2B
-- model. Both governing documents require the notice window as a STRUCTURAL
-- control, not a product option:
--
--   Revised Concept §3.2 steps 4-5 — "Pre-publication notice sent to the named
--     individual with the evidence summary and a defined response window
--     (e.g. 14 days)"; contested cases are re-examined by the Dragon Innovation
--     review team, whose decision is final for publication purposes.
--   Revised Concept, central design principle — publication of any adverse
--     claim must be "evidence-gated, time-limited, and paired with a right of
--     reply before it is ever visible to another employer".
--   Technical Doc §5 Right of reply — "`disputes` and the notice window are
--     structural, not optional — a report cannot move from `pending_review` to
--     `approved` without passing through `notice_sent` and a fixed response
--     window".
--
-- The Independent Review Board is deliberately NOT restored: Revised Concept §4
-- states the role does not exist at launch (no in-house or offline legal team),
-- and contested cases are re-reviewed by the Dragon Innovation review team —
-- i.e. an admin_reviewer / super_admin. `independent_review_board_cases` stays
-- in the schema, unused, pending the risk-register item to revisit a board once
-- volume justifies it.
--
-- The 0008 correction path (withdraw / correct a published report) is KEPT. It
-- is not a substitute for the notice window, but it does implement Concept §4's
-- standing right for a data subject to dispute "at any time, not only at
-- submission".
-- ===========================================================================

-- --- Lifecycle gate ----------------------------------------------------------
-- Re-assert the full status vocabulary, now including 'withdrawn'.
ALTER TABLE conduct_reports DROP CONSTRAINT conduct_reports_status_check;
ALTER TABLE conduct_reports ADD CONSTRAINT conduct_reports_status_check
  CHECK (status IN ('draft', 'pending_review', 'notice_sent', 'disputed',
                    'approved', 'rejected', 'expired', 'withdrawn'));

-- Data-layer backstop for the right-of-reply gate. Stricter than the trigger
-- 0002 shipped: publication requires that a notice was sent, that its response
-- window has actually elapsed, and that no dispute is still open. A report that
-- went to 'disputed' is resolved by the reviewer, which clears the flag below.
CREATE OR REPLACE FUNCTION enforce_notice_before_approval()
RETURNS trigger AS $$
DECLARE
  open_disputes int;
BEGIN
  IF NEW.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.notice_sent_at IS NULL THEN
    RAISE EXCEPTION 'report % cannot be approved before a notice has been sent', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.response_window_ends_at IS NULL OR NEW.response_window_ends_at > now() THEN
    RAISE EXCEPTION 'report % cannot be approved before its response window closes', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO open_disputes
    FROM disputes WHERE report_id = NEW.id AND resolved_at IS NULL;
  IF open_disputes > 0 THEN
    RAISE EXCEPTION 'report % has an unresolved dispute and cannot be approved', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_notice_gate
  BEFORE UPDATE OF status ON conduct_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_notice_before_approval();

-- --- Notice delivery ---------------------------------------------------------
-- The subject acts on a notice without an account (Technical Doc §4: "Subject
-- (token-based access, no full account required)"), so the report carries a
-- hashed notice token. Only the hash is stored — a database leak does not yield
-- usable notice tokens.
ALTER TABLE conduct_reports
  ADD COLUMN IF NOT EXISTS notice_token_hash text UNIQUE;

-- Dispatch record for the Notification Service (Technical Doc §1, §2 background
-- jobs). `subjects` deliberately holds no contact details, so the address the
-- notice goes to is supplied per-report by the submitting employer, lives only
-- here, and is purged when the notice window closes. Keeping it off `subjects`
-- means declining to report someone never leaves a contact record behind.
CREATE TABLE report_notices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     uuid NOT NULL REFERENCES conduct_reports(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('email', 'sms', 'manual')),
  destination   text,               -- purged once the window closes
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed', 'undeliverable')),
  attempts      int  NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX idx_report_notices_report  ON report_notices(report_id);
CREATE INDEX idx_report_notices_pending ON report_notices(status) WHERE status = 'pending';

-- --- Disputes ----------------------------------------------------------------
-- 0002 created `disputes` for the subject's response. Resolution is recorded
-- here so the notice gate above can tell an open dispute from a settled one.
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS resolved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by  uuid REFERENCES platform_users(id),
  ADD COLUMN IF NOT EXISTS outcome      text
    CHECK (outcome IN ('upheld', 'overturned')),
  ADD COLUMN IF NOT EXISTS resolution_notes text;

-- One open dispute per report; the subject may file again if a later notice runs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_open_per_report
  ON disputes(report_id) WHERE resolved_at IS NULL;

-- --- RLS for the new table ---------------------------------------------------
-- Same posture as `disputes` in 0006: platform staff, plus the service-internal
-- 'system' context used by the token-verified subject path and the worker.
ALTER TABLE report_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY report_notices_machine ON report_notices
  USING (app_is_platform() OR app_user_type() = 'system')
  WITH CHECK (app_is_platform() OR app_user_type() = 'system');

-- The submitting employer supplies the notice address when it submits the
-- report, so it needs INSERT on its own report's notice — and nothing else.
-- There is no matching SELECT policy: an employer cannot read notice rows back,
-- so this is never a channel for learning about another company's reports.
CREATE POLICY report_notices_owner_insert ON report_notices FOR INSERT
  WITH CHECK (
    app_user_type() = 'company'
    AND EXISTS (
      SELECT 1 FROM conduct_reports r
       WHERE r.id = report_notices.report_id
         AND r.submitted_by_company_id = app_company_id()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON report_notices TO hyper_app;

-- --- Reopen reports published without a notice -------------------------------
-- Any report approved under the 0008 direct-publish model never had a notice
-- sent, so it is live against a person who was never told and never got to
-- reply — exactly what the documents forbid. Those go back to 'pending_review'
-- and become invisible to other employers until a reviewer re-runs the notice
-- step. Reports 0008 migrated out of 'notice_sent'/'disputed' keep their
-- notice_sent_at and are left alone: a notice did run for them.
UPDATE conduct_reports
   SET status                  = 'pending_review',
       notice_sent_at          = NULL,
       response_window_ends_at = NULL,
       expiry_date             = NULL
 WHERE status = 'approved'
   AND notice_sent_at IS NULL;
