-- New employment checks must identify the requester's documented authority.
-- Existing requests predate this control and remain explicitly marked as such.
ALTER TABLE verification_requests
  ADD COLUMN authorization_basis text NOT NULL DEFAULT 'legacy_no_record'
    CHECK (authorization_basis IN (
      'employee_consent',
      'job_application_authorization',
      'documented_lawful_basis',
      'legacy_no_record'
    )),
  ADD COLUMN authorization_reference text,
  ADD COLUMN authorization_confirmed_at timestamptz;

ALTER TABLE verification_requests
  ADD CONSTRAINT verification_requests_authorization_complete
  CHECK (
    authorization_basis = 'legacy_no_record'
    OR (
      authorization_reference IS NOT NULL
      AND length(btrim(authorization_reference)) > 0
      AND authorization_confirmed_at IS NOT NULL
    )
  );

COMMENT ON COLUMN verification_requests.authorization_basis IS
  'Employer-declared authority for the check. New requests cannot use legacy_no_record.';
COMMENT ON COLUMN verification_requests.authorization_reference IS
  'Reference to the consent, job application authority, or other documented basis; not the document itself.';
