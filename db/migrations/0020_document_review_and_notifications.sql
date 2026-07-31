-- ===========================================================================
-- 0020_document_review_and_notifications
--
-- Two features that belong together, because the first one is the main thing
-- the second one needs to tell companies about.
--
-- 1. DOCUMENT REVIEW. Until now `verifyCompany` only checked that a file of
--    each required type EXISTED. Nobody had to open it. A company could upload
--    a blank page named "dica.pdf" and pass the gate. Each document now carries
--    its own decision, and verification requires the required documents to be
--    APPROVED — so the checklist is load-bearing rather than decorative.
--
-- 2. NOTIFICATIONS. Stored as a `kind` plus JSON params, NOT as rendered
--    sentences. The platform is bilingual: a notice written in English at
--    creation time would still be English when a Burmese-speaking user reads
--    it three days later. Keeping the key and its parameters lets the reader's
--    own language decide, and lets wording be corrected retrospectively.
-- ===========================================================================

-- --- Per-document review -----------------------------------------------------
ALTER TABLE company_documents
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected')),
  ADD COLUMN IF NOT EXISTS review_reason text,
  ADD COLUMN IF NOT EXISTS reviewed_by   uuid REFERENCES platform_users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz;

-- A rejection has to say why — it is the only thing the company can act on.
ALTER TABLE company_documents
  ADD CONSTRAINT company_documents_rejection_needs_reason
  CHECK (review_status <> 'rejected' OR review_reason IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_company_documents_review
  ON company_documents(company_id, review_status);

-- Documents belonging to companies that were verified under the old rule are
-- treated as approved: they were accepted, even if implicitly, and re-opening
-- them would suspend working accounts. Everything else starts pending.
UPDATE company_documents d
   SET review_status = 'approved',
       reviewed_at   = c.registration_verified_at
  FROM companies c
 WHERE c.id = d.company_id
   AND c.registration_verified_at IS NOT NULL;

-- --- Notifications -----------------------------------------------------------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Null means "everyone at this company". A specific user is used when the
  -- notice is personal rather than organisational.
  user_id     uuid REFERENCES company_users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  -- Interpolation values for the translated message (counts, names, dates).
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where clicking the notice should take the reader.
  link        text,
  severity    text NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'success', 'warning', 'error')),
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_company ON notifications(company_id, created_at DESC);
-- The unread-badge query, which runs on every page load.
CREATE INDEX idx_notifications_unread ON notifications(company_id)
  WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_scope ON notifications
  USING (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id());

GRANT SELECT, INSERT, UPDATE ON notifications TO hyper_app;
