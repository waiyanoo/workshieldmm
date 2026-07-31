-- ===========================================================================
-- 0003_audit — append-only audit log in a dedicated schema.
--
-- Design intent (§2 Audit logging, §5 Audit immutability):
--   * Separate schema so it survives even if the application DB/role is
--     compromised at the table level.
--   * The application role is granted INSERT + SELECT only — NO UPDATE/DELETE
--     grants exist at the database level, so entries cannot be rewritten or
--     removed by the app under any code path.
--   * Every state-changing endpoint writes here in the SAME transaction as the
--     change it records — audit entries are not a best-effort side effect. (§4)
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS audit;
GRANT USAGE ON SCHEMA audit TO hyper_app;

CREATE TABLE audit.audit_logs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id      uuid,                         -- null for anonymous/system
  actor_type    text NOT NULL CHECK (actor_type IN ('user','admin','system')),
  action        text NOT NULL,                -- e.g. 'company.verify'
  resource_type text NOT NULL,                -- e.g. 'company'
  resource_id   text,
  metadata      jsonb NOT NULL DEFAULT '{}',  -- no raw evidence/PII — refs only
  ip_address    inet,
  "timestamp"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_actor    ON audit.audit_logs(actor_id);
CREATE INDEX idx_audit_resource ON audit.audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_time     ON audit.audit_logs("timestamp");

-- Grant INSERT + SELECT only. Deliberately NO UPDATE, NO DELETE, NO TRUNCATE.
GRANT INSERT, SELECT ON audit.audit_logs TO hyper_app;

-- Belt-and-braces: a rule that raises on any UPDATE/DELETE attempt, so even a
-- future accidental grant can't silently enable mutation.
CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_no_update
  BEFORE UPDATE ON audit.audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

CREATE TRIGGER trg_audit_no_delete
  BEFORE DELETE ON audit.audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
