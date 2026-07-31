-- ===========================================================================
-- 0001_init — extensions, application role, shared triggers, and the
-- verification-tier (Tier A) + auth tables.
--
-- Migrations run as the OWNER role (hyper). The application connects as the
-- limited role (hyper_app) created here, so row-level security and the
-- append-only audit grants in later migrations actually bind the app. (§5)
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive emails

-- --- Application role -------------------------------------------------------
-- In production this role is provisioned by infra with a vault-supplied
-- password; created here idempotently so local dev "just works".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyper_app') THEN
    CREATE ROLE hyper_app LOGIN PASSWORD 'hyper_app_pw';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE hyper TO hyper_app;
GRANT USAGE ON SCHEMA public TO hyper_app;

-- Default privileges: tables created AFTER this run grant CRUD to the app,
-- EXCEPT where a later migration deliberately narrows them (audit_logs).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hyper_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hyper_app;

-- --- updated_at trigger -----------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- Employers using the platform
-- ===========================================================================
CREATE TABLE companies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name                text NOT NULL,
  registration_number       text NOT NULL,           -- DICA business registration
  registration_verified_at  timestamptz,
  status                    text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','verified','suspended')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registration_number)
);
CREATE TRIGGER trg_companies_updated
  BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Company (employer) users — they authenticate.
-- ===========================================================================
CREATE TABLE company_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  email         citext NOT NULL,
  role          text NOT NULL CHECK (role IN ('company_admin','company_user')),
  password_hash text NOT NULL,
  mfa_secret    text,                 -- TOTP secret (optional for company users)
  mfa_enabled   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE INDEX idx_company_users_company ON company_users(company_id);
CREATE TRIGGER trg_company_users_updated
  BEFORE UPDATE ON company_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Platform staff — super admin, admin reviewer, independent review board.
-- Separate population from employers; MFA enforced in the app for all three
-- roles (§2). Never affiliated with a subscribing employer (concept §4).
-- ===========================================================================
CREATE TABLE platform_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     text NOT NULL,
  email         citext NOT NULL,
  role          text NOT NULL
                  CHECK (role IN ('super_admin','admin_reviewer','review_board')),
  password_hash text NOT NULL,
  mfa_secret    text,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE TRIGGER trg_platform_users_updated
  BEFORE UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Refresh tokens (rotating). Only the hash is stored; the raw token lives
-- solely in the client. Revocation + rotation supported via revoked_at /
-- replaced_by. (§2 Auth: refresh tokens)
-- ===========================================================================
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  user_type   text NOT NULL CHECK (user_type IN ('company','platform')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  user_agent  text,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id, user_type);

-- ===========================================================================
-- Subscriptions — which tier a company is entitled to. Tier B entitlement is
-- necessary but NOT sufficient to use Tier B (the feature flag + legal gate
-- still apply at the API layer). (§7)
-- ===========================================================================
CREATE TABLE subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tier           text NOT NULL CHECK (tier IN ('A','B')),
  status         text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','past_due','cancelled')),
  billing_cycle  text NOT NULL DEFAULT 'monthly'
                   CHECK (billing_cycle IN ('monthly','annual')),
  start_date     date NOT NULL DEFAULT current_date,
  end_date       date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_company ON subscriptions(company_id);
-- One active subscription per (company, tier).
CREATE UNIQUE INDEX uq_active_subscription
  ON subscriptions(company_id, tier) WHERE status = 'active';
CREATE TRIGGER trg_subscriptions_updated
  BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Subjects — the individual a verification or report concerns.
-- Minimal PII by design; not a full profile store. national_id is stored ONLY
-- as a peppered hash, never raw. (§3 / §5 Data minimization)
-- ===========================================================================
CREATE TABLE subjects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         text NOT NULL,
  national_id_hash  text NOT NULL,     -- HMAC(national_id, pepper); never raw
  date_of_birth     date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (national_id_hash)
);
CREATE TRIGGER trg_subjects_updated
  BEFORE UPDATE ON subjects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- Tier A — verification-only checks. No allegations, no subjective judgment.
-- ===========================================================================
CREATE TABLE verification_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subject_id    uuid NOT NULL REFERENCES subjects(id),
  requested_by  uuid NOT NULL REFERENCES company_users(id),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','completed','not_found')),
  result        text,                  -- e.g. "employment dates confirmed"
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_verifications_company ON verification_requests(company_id);
CREATE INDEX idx_verifications_subject ON verification_requests(subject_id);
CREATE TRIGGER trg_verifications_updated
  BEFORE UPDATE ON verification_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
