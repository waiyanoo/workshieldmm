-- ===========================================================================
-- 0012_store_national_id — keep the NRC number in readable form.
--
-- Product decision (July 2026): reviewers need to see the NRC to confirm they
-- are looking at the right person, and the operator's position is that NRC
-- numbers do not warrant encryption in the Myanmar market.
--
-- This reverses the data-minimization rule in Technical Doc §3 ("Personally
-- identifying fields on `subjects` are intentionally minimal") and Revised
-- Concept §5 ("store only what's needed"). The practical effect: a database
-- breach now exposes NRC numbers attached to misconduct allegations, which is
-- the scenario the risk register rates Medium/High ("it's allegations, not just
-- contact info"). Access control, RLS and the audit trail are unchanged and now
-- carry more of the weight.
--
-- `national_id_hash` is KEPT and remains the matching key: it is the unique
-- constraint that de-duplicates a person across companies, and it is what the
-- Tier B search matches on. The raw value is additive, not a replacement.
-- ===========================================================================

ALTER TABLE subjects
  ADD COLUMN IF NOT EXISTS national_id text;

COMMENT ON COLUMN subjects.national_id IS
  'Raw NRC, shown to reviewers to confirm identity. Nullable: rows created '
  'before 0012 have only the hash and cannot be backfilled, since the hash is '
  'a one-way HMAC.';
