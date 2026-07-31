-- ===========================================================================
-- 0004_rls — PostgreSQL row-level security.
--
-- RBAC is enforced first at the API layer; RLS is the second layer so that a
-- query bug still can't leak cross-company data. (§5 Access control)
--
-- The API opens a transaction per request and sets these session GUCs with
-- SET LOCAL, so they never leak across pooled connections:
--   app.user_type   = 'company' | 'platform' | 'subject' | 'system'
--   app.company_id  = <uuid>   (company users only)
--   app.user_id     = <uuid>
-- Policies bind the non-owner application role (hyper_app). The owner (hyper),
-- used only by migrations, bypasses RLS except where FORCE is set.
-- ===========================================================================

-- --- GUC accessor helpers (safe when unset) --------------------------------
CREATE OR REPLACE FUNCTION app_user_type() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('app.user_type', true) $$;

CREATE OR REPLACE FUNCTION app_company_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.company_id', true), '')::uuid
  $$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT current_setting('app.user_type', true) = 'platform'
  $$;

-- --- companies --------------------------------------------------------------
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY companies_read ON companies FOR SELECT
  USING (app_is_platform() OR id = app_company_id());
CREATE POLICY companies_write ON companies FOR UPDATE
  USING (app_is_platform() OR id = app_company_id())
  WITH CHECK (app_is_platform() OR id = app_company_id());
-- Registration is a public action; INSERT is allowed and the row starts
-- 'pending' regardless of session. (§4 POST /companies)
CREATE POLICY companies_insert ON companies FOR INSERT WITH CHECK (true);

-- --- company_users ----------------------------------------------------------
ALTER TABLE company_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_users_scope ON company_users
  USING (app_is_platform() OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR company_id = app_company_id());
-- Registration/login flows need to look up a user by email before a company
-- session exists; that path runs as 'system'.
CREATE POLICY company_users_system ON company_users FOR SELECT
  USING (app_user_type() = 'system');

-- --- subscriptions ----------------------------------------------------------
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_scope ON subscriptions
  USING (app_is_platform() OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR company_id = app_company_id());

-- --- subjects (shared entity; not company-scoped) ---------------------------
-- Any authenticated actor may resolve/create a subject to run a check against.
-- Enumeration is bounded by rate limiting, not RLS. (§5 Rate limiting)
ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY subjects_authenticated ON subjects
  USING (app_user_type() IN ('company','platform','system'))
  WITH CHECK (app_user_type() IN ('company','platform','system'));

-- --- verification_requests (Tier A; strict company isolation) ---------------
ALTER TABLE verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY verifications_scope ON verification_requests
  USING (app_is_platform() OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR company_id = app_company_id());

-- --- conduct_reports (Tier B; submitting-company isolation) ------------------
-- Cross-company read of a PUBLISHED report is mediated by an approved
-- access_request and added with the Tier B rollout; baseline is own-company +
-- platform only.
ALTER TABLE conduct_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduct_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY reports_scope ON conduct_reports
  USING (app_is_platform() OR submitted_by_company_id = app_company_id())
  WITH CHECK (app_is_platform() OR submitted_by_company_id = app_company_id());

-- --- evidence_files (via owning report) -------------------------------------
ALTER TABLE evidence_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_files FORCE ROW LEVEL SECURITY;
CREATE POLICY evidence_scope ON evidence_files
  USING (
    app_is_platform() OR EXISTS (
      SELECT 1 FROM conduct_reports r
      WHERE r.id = evidence_files.report_id
        AND r.submitted_by_company_id = app_company_id()
    )
  )
  WITH CHECK (
    app_is_platform() OR EXISTS (
      SELECT 1 FROM conduct_reports r
      WHERE r.id = evidence_files.report_id
        AND r.submitted_by_company_id = app_company_id()
    )
  );

-- --- access_requests --------------------------------------------------------
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY access_requests_scope ON access_requests
  USING (app_is_platform() OR requesting_company_id = app_company_id())
  WITH CHECK (app_is_platform() OR requesting_company_id = app_company_id());
