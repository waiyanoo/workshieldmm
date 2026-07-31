-- ===========================================================================
-- 0006_tier_b_access — RLS adjustments for the Tier B lifecycle.
--
-- Two machine paths need controlled access to conduct_reports:
--   * the background workers (auto-approve lapsed notices, expiry/purge), and
--   * the subject dispute path (token-based, no account — concept §4), which
--     runs under the service-internal 'system' context after the signed
--     notice token has already scoped it to exactly one report.
-- Both run as app.user_type = 'system', so the report/evidence policies gain
-- that predicate. Company isolation is unchanged.
--
-- The review tables (review_cases, disputes, board cases) get FORCE RLS:
-- platform staff and machine paths only — employers never read dispute
-- content directly. (§5 Access control; Tier B "stricter access controls")
-- ===========================================================================

-- --- conduct_reports: add the machine path -----------------------------------
DROP POLICY reports_scope ON conduct_reports;
CREATE POLICY reports_scope ON conduct_reports
  USING (
    app_is_platform()
    OR app_user_type() = 'system'
    OR submitted_by_company_id = app_company_id()
  )
  WITH CHECK (
    app_is_platform()
    OR app_user_type() = 'system'
    OR submitted_by_company_id = app_company_id()
  );

-- --- evidence_files: same machine path (expiry purge deletes rows) -----------
DROP POLICY evidence_scope ON evidence_files;
CREATE POLICY evidence_scope ON evidence_files
  USING (
    app_is_platform()
    OR app_user_type() = 'system'
    OR EXISTS (
      SELECT 1 FROM conduct_reports r
      WHERE r.id = evidence_files.report_id
        AND r.submitted_by_company_id = app_company_id()
    )
  )
  WITH CHECK (
    app_is_platform()
    OR app_user_type() = 'system'
    OR EXISTS (
      SELECT 1 FROM conduct_reports r
      WHERE r.id = evidence_files.report_id
        AND r.submitted_by_company_id = app_company_id()
    )
  );

-- --- review_cases: platform staff only ---------------------------------------
ALTER TABLE review_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY review_cases_platform ON review_cases
  USING (app_is_platform())
  WITH CHECK (app_is_platform());

-- --- disputes: platform staff + the token-verified subject path --------------
ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes FORCE ROW LEVEL SECURITY;
CREATE POLICY disputes_machine ON disputes
  USING (app_is_platform() OR app_user_type() = 'system')
  WITH CHECK (app_is_platform() OR app_user_type() = 'system');

-- --- independent_review_board_cases: same ------------------------------------
ALTER TABLE independent_review_board_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE independent_review_board_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY irb_machine ON independent_review_board_cases
  USING (app_is_platform() OR app_user_type() = 'system')
  WITH CHECK (app_is_platform() OR app_user_type() = 'system');
