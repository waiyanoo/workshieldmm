-- ===========================================================================
-- 0021_team_receipts_and_queue — three features, one schema change.
--
-- 3. TEAM MANAGEMENT. Invites, deactivation, MFA reset, and attribution.
--    Attribution is the part with teeth: `verification_requests` already
--    recorded `requested_by`, but `conduct_reports` recorded only the company.
--    "Who filed this allegation" is exactly the question you need answered when
--    a report turns out to be wrong, so the user is now recorded too.
--
-- 4. RECEIPTS. No new storage — a receipt is a view over payment_intents,
--    which already holds the reference code, amount, method and decision. The
--    only thing missing was a human-facing receipt number, added here so a
--    company can quote something shorter than a UUID.
--
-- 5. REVIEWER QUEUE. Assignment, notes, a "needs more information" state, and
--    the timestamps that make turnaround measurable. Turnaround could be
--    derived from the audit log, but querying an append-only log for an
--    operational metric is the wrong shape — `decided_at` is cheap and exact.
-- ===========================================================================

-- --- 3. Team management -------------------------------------------------------
CREATE TABLE company_user_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email        citext NOT NULL,
  role         text NOT NULL CHECK (role IN ('company_admin', 'company_user')),
  -- Only the hash is stored: an invite token is a credential that creates an
  -- account, so a database leak must not yield usable ones.
  token_hash   text NOT NULL UNIQUE,
  invited_by   uuid NOT NULL REFERENCES company_users(id),
  full_name    text,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_user_id uuid REFERENCES company_users(id),
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_invites_company ON company_user_invites(company_id, created_at DESC);

-- One live invite per address per company. Re-inviting someone who already has
-- an open invite should reuse or replace it, not create a second usable token.
CREATE UNIQUE INDEX idx_invites_one_open_per_email
  ON company_user_invites(company_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE company_user_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_user_invites FORCE ROW LEVEL SECURITY;
CREATE POLICY invites_scope ON company_user_invites
  USING (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id());
GRANT SELECT, INSERT, UPDATE ON company_user_invites TO hyper_app;

-- Who filed a conduct report, not merely which company.
ALTER TABLE conduct_reports
  ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid REFERENCES company_users(id);

-- --- 4. Receipts ---------------------------------------------------------------
-- A short, human-quotable number. Sequence-backed so it is stable and ordered;
-- the reference code on the intent stays the reconciliation key.
CREATE SEQUENCE IF NOT EXISTS receipt_number_seq START 1000;

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS receipt_number text UNIQUE;

-- Existing confirmed payments get one so their receipts are not blank.
UPDATE payment_intents
   SET receipt_number = 'WS-R-' || lpad(nextval('receipt_number_seq')::text, 6, '0')
 WHERE status = 'confirmed' AND receipt_number IS NULL;

-- --- 5. Reviewer work queue ----------------------------------------------------
ALTER TABLE verification_requests
  ADD COLUMN IF NOT EXISTS assigned_to  uuid REFERENCES platform_users(id),
  ADD COLUMN IF NOT EXISTS assigned_at  timestamptz,
  ADD COLUMN IF NOT EXISTS reviewer_note text,
  ADD COLUMN IF NOT EXISTS info_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS info_request text,
  ADD COLUMN IF NOT EXISTS decided_at   timestamptz;

-- `need_more_info` is a real stop in the lifecycle: the check is not pending
-- (nobody should pick it up) and not decided (the company owes an answer).
ALTER TABLE verification_requests DROP CONSTRAINT IF EXISTS verification_requests_status_check;
ALTER TABLE verification_requests ADD CONSTRAINT verification_requests_status_check
  CHECK (status IN ('pending', 'need_more_info', 'completed', 'not_found'));

CREATE INDEX IF NOT EXISTS idx_verifications_queue
  ON verification_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_verifications_assigned
  ON verification_requests(assigned_to, status);

-- Backfill turnaround for checks already decided, so the metric is not empty on
-- day one. `updated_at` is the closest honest proxy for when the decision
-- landed; rows decided before this migration are approximate by nature.
UPDATE verification_requests
   SET decided_at = updated_at
 WHERE status IN ('completed', 'not_found') AND decided_at IS NULL;
