-- Immutable acceptance trail for the two company-facing declarations: joining
-- the platform and submitting a conduct report about a person.
CREATE TABLE company_declarations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_user_id     uuid NOT NULL REFERENCES company_users(id) ON DELETE RESTRICT,
  conduct_report_id   uuid REFERENCES conduct_reports(id) ON DELETE RESTRICT,
  kind                text NOT NULL CHECK (kind IN ('registration', 'report_submission')),
  declaration_version text NOT NULL,
  accepted_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'registration' AND conduct_report_id IS NULL)
    OR (kind = 'report_submission' AND conduct_report_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX company_declarations_registration_once
  ON company_declarations(company_id) WHERE kind = 'registration';
CREATE UNIQUE INDEX company_declarations_report_once
  ON company_declarations(conduct_report_id) WHERE kind = 'report_submission';
CREATE INDEX idx_company_declarations_company ON company_declarations(company_id, accepted_at DESC);

ALTER TABLE company_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_declarations FORCE ROW LEVEL SECURITY;
CREATE POLICY company_declarations_scope ON company_declarations
  USING (app_is_platform() OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR company_id = app_company_id());
GRANT SELECT, INSERT ON company_declarations TO hyper_app;
