-- ===========================================================================
-- 0019_profile_contact_details — self-service contact details.
--
-- A company and its authorized person can maintain their own contact
-- information. The split matters:
--
--   EDITABLE by the company   phone, contact email, address, township, city,
--                             region — operational details that change on their
--                             own and were never part of any verification.
--
--   LOCKED                    legal_name, registration_number, status, plan.
--                             These are the verified identity. If a company
--                             could rename itself after verification, the DICA
--                             check would mean nothing: verify as one entity,
--                             then trade as another. Changing them stays an
--                             admin action with an audit entry.
--
-- `contact_email` is deliberately separate from company_users.email. The latter
-- is a login credential — letting it be edited from a profile screen makes
-- account takeover a two-click affair — so it is not touched here.
--
-- The guard at the bottom is what actually enforces the split: even a bug in
-- the API cannot rename a verified company through the profile path, because
-- the database refuses a legal_name or registration_number change made in the
-- company's own RLS context.
-- ===========================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS phone         text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS address_line  text,
  ADD COLUMN IF NOT EXISTS township      text,
  ADD COLUMN IF NOT EXISTS city          text,
  ADD COLUMN IF NOT EXISTS region        text;

COMMENT ON COLUMN companies.contact_email IS
  'Operational contact address. NOT a login — company_users.email is the '
  'credential and is not editable from the profile screen.';

-- The authorized person's own contact number.
ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS phone text;

-- --- Identity fields are not self-editable -----------------------------------
CREATE OR REPLACE FUNCTION enforce_company_identity_locked()
RETURNS trigger AS $$
BEGIN
  -- Platform staff and the service context may still correct these; only the
  -- company acting on its own record is restricted.
  IF app_user_type() <> 'company' THEN
    RETURN NEW;
  END IF;

  IF NEW.legal_name IS DISTINCT FROM OLD.legal_name THEN
    RAISE EXCEPTION 'legal name is part of the verified identity and cannot be changed here'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.registration_number IS DISTINCT FROM OLD.registration_number THEN
    RAISE EXCEPTION 'registration number is part of the verified identity and cannot be changed here'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'company status is set by the platform, not by the company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.plan IS DISTINCT FROM OLD.plan
     OR NEW.monthly_credit_override IS DISTINCT FROM OLD.monthly_credit_override THEN
    RAISE EXCEPTION 'plan changes go through billing, not the profile screen'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_identity_locked
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION enforce_company_identity_locked();
