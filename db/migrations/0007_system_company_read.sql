-- ===========================================================================
-- 0007_system_company_read — allow the service-internal 'system' context to
-- READ companies.
--
-- Machine paths (granted cross-company report reads, notice dispatch,
-- lifecycle sweeps) join companies for display names; without this the JOIN
-- silently filters the row under RLS. Read-only: system gains no
-- INSERT/UPDATE on companies. company_users already has an equivalent
-- system SELECT policy for the login path.
-- ===========================================================================

DROP POLICY companies_read ON companies;
CREATE POLICY companies_read ON companies FOR SELECT
  USING (
    app_is_platform()
    OR app_user_type() = 'system'
    OR id = app_company_id()
  );
