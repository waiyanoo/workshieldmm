-- ===========================================================================
-- 0033_declaration_locale — which language the declaration was read in.
--
-- The record already says which version was accepted, and the version resolves
-- to exact wording in both languages. What it could not say is which of those
-- two paragraphs the person actually read — and for a Myanmar platform that is
-- the difference between meaningful consent and a checkbox.
--
-- Backfilled to 'en', which is not a guess: version 2026-08 carried no Burmese
-- translation at all, so every acceptance recorded before this migration was
-- shown the English text regardless of the interface language chosen. 2026-08.2
-- is the first version with a Burmese paragraph to read.
--
-- This records the language of the TEXT DISPLAYED, not the user's interface
-- preference. They are the same thing from 2026-08.2 onward; they were not
-- before, and the column has to mean the former to be worth storing.
-- ===========================================================================

ALTER TABLE company_declarations
  ADD COLUMN accepted_locale text NOT NULL DEFAULT 'en'
    CHECK (accepted_locale IN ('en', 'my'));

COMMENT ON COLUMN company_declarations.accepted_locale IS
  'Language of the declaration text shown when it was accepted. Rows predating '
  '0033 are en because no Burmese translation existed before version 2026-08.2.';
