-- ===========================================================================
-- 0005_company_documents — verification documents for employer onboarding.
--
-- Business legitimacy: a DICA certificate OR a shop license.
-- Person in charge: an NRC copy.
--
-- Only a reference + hash live in the DB; the file bytes are in encrypted
-- object storage, never inline. RLS scopes rows to the owning company (or
-- platform staff). (§2 File storage, §5 Access control / Data minimization)
-- ===========================================================================

CREATE TABLE company_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  doc_type     text NOT NULL
                 CHECK (doc_type IN ('dica_certificate', 'shop_license', 'nrc')),
  storage_ref  text NOT NULL,        -- object key in the documents bucket
  file_hash    text NOT NULL,        -- sha256 of the stored bytes
  content_type text,
  byte_size    bigint,
  uploaded_by  uuid NOT NULL REFERENCES company_users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_company_documents_company ON company_documents(company_id);

ALTER TABLE company_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY company_documents_scope ON company_documents
  USING (app_is_platform() OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR company_id = app_company_id());
