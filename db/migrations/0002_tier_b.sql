-- ===========================================================================
-- 0002_tier_b — conduct-report tables (Tier B).
--
-- These tables exist from day one so the compliance model is structural, but
-- the Tier B API endpoints stay behind FEATURE_TIER_B_ENABLED (off by default
-- in every environment) until Phase 0 legal review and the independent review
-- board are operational. (§7, concept §9/§11)
-- ===========================================================================

-- --- Report categories ------------------------------------------------------
-- Taxonomy tied to documented policy violations. `eligible = false` marks the
-- hard-excluded categories (protected activity). Policy-controlled: seeded and
-- changed only via reviewed migration, never a runtime admin edit. (§3.2)
CREATE TABLE report_categories (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key                   text NOT NULL UNIQUE,        -- stable machine key
  name                  text NOT NULL,
  description           text NOT NULL,
  evidence_requirements text NOT NULL,
  eligible              boolean NOT NULL,            -- false = cannot be reported on
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_report_categories_updated
  BEFORE UPDATE ON report_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Conduct reports --------------------------------------------------------
-- Linear, gated lifecycle. A report cannot reach 'approved' without passing
-- through 'notice_sent' (right of reply). The transition rules live in the API
-- state machine AND are backstopped by the trigger below. (§5 Right of reply)
CREATE TABLE conduct_reports (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitted_by_company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  subject_id              uuid NOT NULL REFERENCES subjects(id),
  category_id             uuid NOT NULL REFERENCES report_categories(id),
  status                  text NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','pending_review','notice_sent',
                                              'disputed','approved','rejected','expired')),
  narrative_summary       text,   -- short, factual; NO freeform allegations field
  notice_sent_at          timestamptz,
  response_window_ends_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  expiry_date             timestamptz    -- auto-expiry, e.g. now() + 3–5 years
);
CREATE INDEX idx_reports_company ON conduct_reports(submitted_by_company_id);
CREATE INDEX idx_reports_subject ON conduct_reports(subject_id);
CREATE INDEX idx_reports_status  ON conduct_reports(status);
CREATE INDEX idx_reports_expiry  ON conduct_reports(expiry_date) WHERE status = 'approved';
CREATE TRIGGER trg_reports_updated
  BEFORE UPDATE ON conduct_reports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Data-layer backstop for the excluded-category rule: even a compromised app
-- role cannot file a report against an ineligible category. (§3.2)
CREATE OR REPLACE FUNCTION enforce_report_category_eligible()
RETURNS trigger AS $$
DECLARE
  is_eligible boolean;
BEGIN
  SELECT eligible INTO is_eligible FROM report_categories WHERE id = NEW.category_id;
  IF is_eligible IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'report category % is not eligible for conduct reports', NEW.category_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_category_eligible
  BEFORE INSERT OR UPDATE OF category_id ON conduct_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_report_category_eligible();

-- Data-layer backstop for the right-of-reply gate: block a direct jump to
-- 'approved' unless the report has been through 'notice_sent'. (§5)
CREATE OR REPLACE FUNCTION enforce_notice_before_approval()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.notice_sent_at IS NULL THEN
    RAISE EXCEPTION 'report % cannot be approved before a notice window has run', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reports_notice_gate
  BEFORE UPDATE OF status ON conduct_reports
  FOR EACH ROW EXECUTE FUNCTION enforce_notice_before_approval();

-- --- Evidence files ---------------------------------------------------------
-- The DB stores only a reference + hash; the bytes live in encrypted object
-- storage with per-file keys, never inlined. (§2 File storage, §5 Encryption)
CREATE TABLE evidence_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id    uuid NOT NULL REFERENCES conduct_reports(id) ON DELETE CASCADE,
  storage_ref  text NOT NULL,        -- object key in the evidence bucket
  uploaded_by  uuid NOT NULL REFERENCES company_users(id),
  file_hash    text NOT NULL,        -- integrity check of the stored object
  content_type text,
  byte_size    bigint,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_report ON evidence_files(report_id);

-- --- Review cases (admin evidence-sufficiency review) -----------------------
CREATE TABLE review_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id   uuid NOT NULL REFERENCES conduct_reports(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES platform_users(id),
  decision    text CHECK (decision IN ('evidence_sufficient','evidence_insufficient')),
  notes       text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_review_cases_report ON review_cases(report_id);

-- --- Disputes (subject's right of reply) ------------------------------------
CREATE TABLE disputes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id             uuid NOT NULL REFERENCES conduct_reports(id) ON DELETE CASCADE,
  subject_response      text,
  filed_at              timestamptz NOT NULL DEFAULT now(),
  review_board_case_id  uuid          -- FK added after the board table exists
);
CREATE INDEX idx_disputes_report ON disputes(report_id);

-- --- Independent review board cases (contested reports only) -----------------
CREATE TABLE independent_review_board_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id      uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  panel_member_ids uuid[] NOT NULL DEFAULT '{}',
  decision        text CHECK (decision IN ('upheld','overturned')),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE disputes
  ADD CONSTRAINT fk_disputes_review_board
  FOREIGN KEY (review_board_case_id)
  REFERENCES independent_review_board_cases(id);

-- --- Access requests (employer requests to view a published report) ---------
CREATE TABLE access_requests (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requesting_company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject_id             uuid NOT NULL REFERENCES subjects(id),
  report_id              uuid NOT NULL REFERENCES conduct_reports(id),
  status                 text NOT NULL DEFAULT 'requested'
                           CHECK (status IN ('requested','approved','denied')),
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_at             timestamptz
);
CREATE INDEX idx_access_requests_company ON access_requests(requesting_company_id);
CREATE INDEX idx_access_requests_report  ON access_requests(report_id);
