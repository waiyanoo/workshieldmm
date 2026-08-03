-- A factual verification outcome must be traceable to the record source the
-- reviewer contacted. A check can have more than one source, but at least one
-- source is recorded with every new final decision at the API layer.
CREATE TABLE verification_sources (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id       uuid NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  reviewer_id           uuid NOT NULL REFERENCES platform_users(id),
  source_company         text NOT NULL,
  contact_name           text NOT NULL,
  contact_details        text,
  contact_method         text NOT NULL CHECK (contact_method IN (
                          'phone', 'email', 'letter', 'portal', 'in_person', 'document', 'other')),
  response               text NOT NULL CHECK (response IN (
                          'employment_confirmed', 'no_record', 'unable_to_confirm')),
  employment_start_date  date,
  employment_end_date    date,
  evidence_reference     text,
  verified_at            timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (employment_end_date IS NULL OR employment_start_date IS NULL
         OR employment_end_date >= employment_start_date)
);
CREATE INDEX idx_verification_sources_request ON verification_sources(verification_id, verified_at DESC);

COMMENT ON TABLE verification_sources IS
  'Structured source trail for reviewer employment-history decisions.';
