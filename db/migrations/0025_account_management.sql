-- ===========================================================================
-- 0025_account_management — admin-issued credentials that must be replaced.
--
-- An administrator resetting somebody's password must never end up KNOWING
-- that password. So the flow is: the system generates a one-time password, the
-- admin passes it on, and the account cannot do anything until the holder has
-- replaced it. That last part is what this column is for — without it, an
-- admin-issued password is simply a working credential the admin also has.
--
-- The same flag covers newly created platform staff: they are handed a
-- temporary password, and MFA enrolment is already forced at first login by
-- mfaRequiredFor(), so a new reviewer sets both before doing anything.
--
-- Defaults false so every existing account is unaffected.
-- ===========================================================================

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN platform_users.must_change_password IS
  'Set when an admin issues a temporary password. Blocks every request except '
  'change-password and logout until the holder replaces it.';
COMMENT ON COLUMN company_users.must_change_password IS
  'Set when an admin issues a temporary password. Blocks every request except '
  'change-password and logout until the holder replaces it.';

-- Who created a staff account. Provisioning someone who can read every
-- company's NRC data should never be untraceable to a person.
ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES platform_users(id);
