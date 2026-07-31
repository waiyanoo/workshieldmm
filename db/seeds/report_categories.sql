-- ===========================================================================
-- Seed: report_categories policy.
--
-- This is the policy document rendered as data. The excluded categories
-- (eligible = false) can never carry an adverse report — enforced by the
-- data-layer trigger in 0002 and the RLS-independent CHECK path. Changing this
-- set is a reviewed policy change (edit here, re-run seed), never a runtime
-- admin action. (§3.2, concept §5)
--
-- Idempotent: safe to re-run.
-- ===========================================================================

INSERT INTO report_categories (key, name, description, evidence_requirements, eligible)
VALUES
  -- ---- Eligible: the reviewed, evidence-gated policy reasons ---------------
  ('falsified_documents',
   'Falsified identity, qualification, or employment documents',
   'Falsified or forged identity, qualification, or employment documents established by investigation.',
   'Original/copy comparison, investigation record',
   true),
  ('theft_fraud_misuse',
   'Theft, fraud, or misuse of company money/property',
   'Theft, fraud, or misuse of company money or property established by documentary evidence.',
   'Audit, inventory, transaction records',
   true),
  ('bribery_corruption_conflict',
   'Bribery, corruption, or undisclosed conflict of interest',
   'Bribery, corruption, or an undisclosed conflict of interest established by investigation.',
   'Investigation finding, relevant records',
   true),
  ('confidentiality_breach',
   'Serious confidentiality or data-security breach',
   'A serious breach of confidentiality or data-security policy with documented impact.',
   'Policy, access logs, evidence of impact',
   true),
  ('violence_harassment_threats',
   'Violence, credible threats, or serious workplace harassment',
   'Violence, credible threats, or serious workplace harassment established by formal investigation.',
   'Formal investigation outcome, witness evidence',
   true),
  ('safety_breach',
   'Serious or repeated safety breach',
   'A serious breach of workplace safety rules, formally documented.',
   'Training record, written warnings, incident report',
   true),
  ('damage_sabotage_systems',
   'Deliberate damage, sabotage, or major misuse of systems',
   'Deliberate damage, sabotage, or major misuse of company property or systems.',
   'Incident report, logs, repair assessment',
   true),
  ('contract_breach_competing',
   'Material breach of contract or unauthorised competing work',
   'A material breach of contract or unauthorised competing work established by signed policy or contract.',
   'Signed policy/contract and evidence',
   true),

  -- ---- Excluded: protected activity — NEVER eligible ----------------------
  ('union_or_labor_organizing',
   'Union or labor-organizing activity',
   'Protected activity. Excluded from adverse reporting.',
   'N/A — category is not eligible for reports.',
   false),
  ('wage_or_hour_dispute',
   'Wage or hour dispute',
   'Protected activity. Excluded from adverse reporting.',
   'N/A — category is not eligible for reports.',
   false),
  ('voluntary_resignation',
   'Voluntary resignation',
   'Not misconduct. Excluded from adverse reporting.',
   'N/A — category is not eligible for reports.',
   false),
  ('medical_or_family_leave',
   'Pregnancy, medical, or family leave',
   'Protected activity. Excluded from adverse reporting.',
   'N/A — category is not eligible for reports.',
   false),
  ('political_affiliation',
   'Political affiliation',
   'Protected activity. Excluded from adverse reporting.',
   'N/A — category is not eligible for reports.',
   false)
ON CONFLICT (key) DO UPDATE SET
  name                  = EXCLUDED.name,
  description           = EXCLUDED.description,
  evidence_requirements = EXCLUDED.evidence_requirements,
  eligible              = EXCLUDED.eligible,
  updated_at            = now();

-- These broad legacy categories are no longer offered for new reports. Keep
-- their database rows so a historical report still has an intelligible
-- category, but make the data-layer gate reject any new use of them.
UPDATE report_categories
   SET eligible = false,
       description = 'Retired category. Kept only for historical reports; not available for new reports.',
       evidence_requirements = 'N/A — retired category.',
       updated_at = now()
 WHERE key IN ('confirmed_theft', 'confirmed_fraud', 'serious_policy_breach');
