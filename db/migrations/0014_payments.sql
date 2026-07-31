-- ===========================================================================
-- 0014_payments — QR credit purchase with manual reconciliation.
--
-- Myanmar mobile money (KBZPay / WavePay) has no merchant callback we can rely
-- on, so settlement is confirmed by a human against the wallet statement. The
-- flow is built so that reconciliation is deterministic rather than guesswork:
--
--   1. The buyer picks a package. We mint a payment_intent with OUR reference
--      code and freeze the price.
--   2. They pay the displayed QR and put that reference code in the transfer
--      note, then key in THEIR wallet transaction id (and optionally attach a
--      screenshot).
--   3. An admin matches the reference code + transaction id against the wallet
--      statement and confirms. Only then are credits granted.
--
-- Why both identifiers: our reference code is what makes a payment findable in
-- the statement without fuzzy amount-and-time matching; their transaction id is
-- what proves which statement line it is. The screenshot is corroboration only.
--
-- SECURITY NOTE: a screenshot must NEVER be sufficient to grant credits — it is
-- an image anyone can fabricate or reuse. Credits are granted solely by an
-- admin's confirm decision, and the unique index on (provider, payer_reference)
-- stops the same wallet transaction being claimed twice.
-- ===========================================================================

-- --- Payment methods the operator displays ----------------------------------
-- Managed in-app so the QR can be rotated without a deploy.
CREATE TABLE payment_methods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL UNIQUE
                  CHECK (provider IN ('kbzpay', 'wavepay', 'bank_transfer')),
  display_name  text NOT NULL,
  account_name  text NOT NULL,
  account_number text NOT NULL,
  qr_storage_ref text,          -- object key of the QR image, if uploaded
  instructions  text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_payment_methods_updated
  BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --- Credit packages ---------------------------------------------------------
-- Priced in MMK, matching how SMEs actually pay (Pricing Plan §1). The
-- credit-to-MMK rate is an open item in §7, so these are a starting point
-- anchored on the Starter plan (49,900 MMK for 100 credits ≈ 499/credit) with
-- volume discounts above that. Editable without a deploy.
CREATE TABLE credit_packages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text NOT NULL UNIQUE,
  name       text NOT NULL,
  credits    int  NOT NULL CHECK (credits > 0),
  price_mmk  int  NOT NULL CHECK (price_mmk > 0),
  sort_order int  NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);

INSERT INTO credit_packages (key, name, credits, price_mmk, sort_order) VALUES
  ('starter_50',  '50 credits',   50,   24950, 1),
  ('standard_100','100 credits',  100,  49900, 2),
  ('bulk_300',    '300 credits',  300, 134700, 3),   -- ~10% off
  ('bulk_1000',   '1000 credits', 1000, 399200, 4);  -- ~20% off

-- --- Payment intents ---------------------------------------------------------
CREATE TABLE payment_intents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES company_users(id),
  package_key     text NOT NULL,
  -- Credits and price are FROZEN at intent creation. If the catalogue changes
  -- while someone is mid-payment they still get what they were quoted.
  credits         int  NOT NULL CHECK (credits > 0),
  amount_mmk      int  NOT NULL CHECK (amount_mmk > 0),
  provider        text NOT NULL
                    CHECK (provider IN ('kbzpay', 'wavepay', 'bank_transfer')),
  -- Ours: goes in the transfer note so the payment is findable in the statement.
  reference_code  text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'awaiting_payment'
                    CHECK (status IN ('awaiting_payment', 'submitted',
                                      'confirmed', 'rejected', 'expired')),
  -- Theirs: the wallet transaction id, keyed in after paying.
  payer_reference text,
  payer_note      text,
  proof_storage_ref text,       -- optional screenshot, corroboration only
  submitted_at    timestamptz,
  decided_at      timestamptz,
  decided_by      uuid REFERENCES platform_users(id),
  decision_note   text,
  credit_lot_id   uuid REFERENCES credit_lots(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX idx_payment_intents_company ON payment_intents(company_id, created_at DESC);
CREATE INDEX idx_payment_intents_queue ON payment_intents(status, submitted_at)
  WHERE status = 'submitted';

-- One wallet transaction can only ever be claimed once. This is the control
-- that stops a buyer re-submitting the same payment (or someone else's) for a
-- second batch of credits.
CREATE UNIQUE INDEX idx_payment_intents_payer_ref
  ON payment_intents(provider, lower(payer_reference))
  WHERE payer_reference IS NOT NULL AND status <> 'rejected';

-- --- RLS ---------------------------------------------------------------------
-- A company sees and creates its own intents; platform staff see all.
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_intents_scope ON payment_intents
  USING (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id())
  WITH CHECK (app_is_platform() OR app_user_type() = 'system' OR company_id = app_company_id());

-- Catalogue and payment details are readable by any authenticated caller — you
-- cannot pay without seeing them — but writable only by platform staff.
ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_packages_read ON credit_packages FOR SELECT USING (true);
CREATE POLICY credit_packages_write ON credit_packages FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_methods_read ON payment_methods FOR SELECT USING (true);
CREATE POLICY payment_methods_write ON payment_methods FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());

GRANT SELECT, INSERT, UPDATE ON payment_intents TO hyper_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_methods TO hyper_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_packages TO hyper_app;
