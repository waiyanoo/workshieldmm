-- New employment checks require the company to affirm the person's consent,
-- but do not collect or require any consent document or reference number.
-- Historical reference values are retained for audit continuity.
ALTER TABLE verification_requests
  DROP CONSTRAINT IF EXISTS verification_requests_authorization_complete;

ALTER TABLE verification_requests
  ADD CONSTRAINT verification_requests_authorization_complete
  CHECK (
    authorization_basis = 'legacy_no_record'
    OR authorization_confirmed_at IS NOT NULL
  );

COMMENT ON COLUMN verification_requests.authorization_basis IS
  'Consent status for the check. New requests use employee_consent; legacy requests remain marked legacy_no_record.';
COMMENT ON COLUMN verification_requests.authorization_reference IS
  'Historical consent reference, retained only for pre-simplification requests. New requests do not collect this value.';
