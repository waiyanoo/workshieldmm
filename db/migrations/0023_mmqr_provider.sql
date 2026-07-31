-- ===========================================================================
-- 0023_mmqr_provider — accept MMQR as a payment method.
--
-- MMQR is the Central Bank of Myanmar's unified QR standard. One merchant QR is
-- scannable by every participating wallet and bank app — KBZPay, AYA Pay, Wave,
-- CB Pay and the rest — so it replaces the per-wallet QR the enum was built
-- around rather than adding a fourth one alongside them.
--
-- The per-wallet providers are LEFT IN PLACE. Historic payment_intents rows
-- reference them, and dropping a value a confirmed payment was reconciled under
-- would rewrite settled financial history to tidy an enum.
--
-- Note on reconciliation: the merchant QR supplied is STATIC (EMVCo tag 01 =
-- 11), so it carries no amount. The payer types the amount and puts our
-- reference code in the transfer note, exactly as the existing flow already
-- assumes — nothing downstream changes.
-- ===========================================================================

ALTER TABLE payment_methods DROP CONSTRAINT IF EXISTS payment_methods_provider_check;
ALTER TABLE payment_methods ADD CONSTRAINT payment_methods_provider_check
  CHECK (provider IN ('mmqr', 'kbzpay', 'wavepay', 'bank_transfer'));

ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check
  CHECK (provider IN ('mmqr', 'kbzpay', 'wavepay', 'bank_transfer'));
