-- ===========================================================================
-- 0024_report_categories_expansion — additional eligible conduct-report
-- categories. Idempotent: safe to re-run.
-- ===========================================================================

INSERT INTO report_categories (key, name, description, evidence_requirements, eligible)
VALUES
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
   'A serious or repeated breach of workplace safety rules, formally documented.',
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
   true)
ON CONFLICT (key) DO UPDATE SET
  name                  = EXCLUDED.name,
  description           = EXCLUDED.description,
  evidence_requirements = EXCLUDED.evidence_requirements,
  eligible              = EXCLUDED.eligible,
  updated_at            = now();
