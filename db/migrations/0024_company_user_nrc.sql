-- ===========================================================================
-- 0024_company_user_nrc — the authorised person's NRC.
--
-- Verification already requires the company to upload a scan of the person in
-- charge's NRC, but nothing recorded the NUMBER. The reviewer was left reading
-- it off the image and comparing it to a name, which is the kind of check that
-- quietly degrades into "the document looks like an NRC".
--
-- Stored in plain text, consistently with subjects.national_id (0012) and for
-- the same reason given then: an NRC is not treated as a secret in Myanmar, and
-- the reviewer has to be able to read it to confirm they are looking at the
-- right person. It is still personal data — RLS scopes it to the owning company
-- and platform staff, exactly as with the rest of the row.
--
-- NULLable on purpose. The registration endpoint requires it from now on, but
-- accounts created before this migration have no NRC to backfill, and a NOT
-- NULL with an invented default would put a fake identifier on a real person.
-- ===========================================================================

ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS national_id text;

COMMENT ON COLUMN company_users.national_id IS
  'NRC of the authorised person, canonical form (e.g. 12/OUKAMA(N)123456). '
  'Null for accounts created before migration 0024.';
