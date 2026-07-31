/**
 * Credit purchase by QR + manual reconciliation. (Pricing Plan §1, §3, §7)
 *
 * Myanmar mobile money gives us no trustworthy merchant callback, so a human
 * confirms every payment against the wallet statement. The design makes that
 * job deterministic instead of guesswork:
 *
 *   - We mint a reference code the buyer puts in the transfer note, so the
 *     payment can be located in the statement without matching on amount+time.
 *   - The buyer keys in their wallet transaction id, which identifies the exact
 *     statement line.
 *   - A screenshot may be attached, but it is corroboration ONLY. It can never
 *     grant credits: an image is trivially fabricated or reused, so the sole
 *     path to credits is an admin's confirm decision.
 */
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { isUniqueViolation } from "../../lib/dbErrors";
import { presignGet, putObject } from "../../lib/storage";
import type { AuthUser } from "../../types/auth";
import { getBalance, grantCredits } from "../credits/credits.service";
import { notify } from "../notifications/notifications.service";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

/** How long a quoted price is held before the intent lapses. */
const INTENT_TTL_HOURS = 24;

const ALLOWED_PROOF_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

/**
 * Reference code the payer types into the transfer note.
 *
 * Crockford-ish alphabet: no 0/O, 1/I/L, or 8/B, because this gets copied by
 * hand off a screen into a banking app and a misread character means a payment
 * nobody can find.
 */
const CODE_ALPHABET = "23456789ACDEFGHJKMNPQRTUVWXYZ";
function generateReferenceCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `WS-${out}`;
}

/**
 * Human-quotable receipt number, e.g. WS-R-001042.
 *
 * A sequence rather than a random string: receipts get filed, quoted in emails
 * and read down a phone line, and "the one after 41" is a thing a person can
 * say. The reference code stays the reconciliation key against the wallet
 * statement — these two numbers answer different questions.
 */
async function nextReceiptNumber(client: PoolClient): Promise<string> {
  const res = await client.query<{ n: string }>(`SELECT nextval('receipt_number_seq') AS n`);
  return `WS-R-${String(res.rows[0]!.n).padStart(6, "0")}`;
}

// --- Catalogue ----------------------------------------------------------------

export async function listPurchaseOptions(user: AuthUser) {
  return withContext(ctxForUser(user), async (client) => {
    const packages = await client.query(
      `SELECT key, name, credits, price_mmk FROM credit_packages
        WHERE active ORDER BY sort_order`
    );
    const plans = await client.query(
      `SELECT plan, display_name, monthly_mmk, annual_mmk, monthly_credits
         FROM plan_prices WHERE active ORDER BY monthly_mmk`
    );
    // What the company is currently paying for, so the screen can show
    // "renews on…" rather than offering a plan they already hold.
    const period = await client.query<{ plan: string; billing_cycle: string; ends_at: string }>(
      `SELECT plan, billing_cycle, ends_at
         FROM company_plan_periods
        WHERE company_id = $1 AND ends_at > now()
        ORDER BY ends_at DESC LIMIT 1`,
      [user.companyId]
    );
    const methods = await client.query(
      `SELECT provider, display_name, account_name, account_number, qr_storage_ref, instructions
         FROM payment_methods WHERE active ORDER BY display_name`
    );

    return {
      currentPlan: period.rows[0]
        ? {
            plan: period.rows[0].plan,
            billingCycle: period.rows[0].billing_cycle,
            endsAt: period.rows[0].ends_at,
          }
        : null,
      plans: plans.rows.map((p) => ({
        plan: p.plan,
        displayName: p.display_name,
        monthlyMmk: p.monthly_mmk,
        annualMmk: p.annual_mmk,
        monthlyCredits: p.monthly_credits,
        // Shown so the annual saving is visible rather than needing arithmetic.
        annualSavingMmk: p.monthly_mmk * 12 - p.annual_mmk,
      })),
      packages: packages.rows.map((p) => ({
        key: p.key,
        name: p.name,
        credits: p.credits,
        priceMmk: p.price_mmk,
        // Shown so buyers can compare packages rather than doing the division.
        mmkPerCredit: Math.round(p.price_mmk / p.credits),
      })),
      methods: await Promise.all(
        methods.rows.map(async (m) => ({
          provider: m.provider,
          displayName: m.display_name,
          accountName: m.account_name,
          accountNumber: m.account_number,
          instructions: m.instructions,
          qrUrl: m.qr_storage_ref ? await presignGet(m.qr_storage_ref, 900) : null,
        }))
      ),
    };
  });
}

// --- Buyer: create an intent, then submit proof --------------------------------

export async function createPaymentIntent(
  user: AuthUser,
  input: { packageKey: string; provider: string; ip?: string | null }
) {
  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    const pkg = await client.query<{ credits: number; price_mmk: number }>(
      `SELECT credits, price_mmk FROM credit_packages WHERE key = $1 AND active`,
      [input.packageKey]
    );
    if (!pkg.rows[0]) throw badRequest("Unknown or inactive credit package");

    const method = await client.query(
      `SELECT 1 FROM payment_methods WHERE provider = $1 AND active`,
      [input.provider]
    );
    if (method.rowCount === 0) throw badRequest("That payment method is not available");

    // Retry on the (astronomically unlikely) code collision rather than 500.
    let created;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await client.query<{
          id: string;
          reference_code: string;
          expires_at: string;
        }>(
          `INSERT INTO payment_intents
             (company_id, created_by, package_key, credits, amount_mmk, provider,
              reference_code, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8))
           RETURNING id, reference_code, expires_at`,
          [
            user.companyId,
            user.id,
            input.packageKey,
            pkg.rows[0].credits,
            pkg.rows[0].price_mmk,
            input.provider,
            generateReferenceCode(),
            INTENT_TTL_HOURS,
          ]
        );
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 4) throw err;
      }
    }

    const intent = created!.rows[0]!;
    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "payment.intent_created",
      resourceType: "payment_intent",
      resourceId: intent.id,
      metadata: {
        packageKey: input.packageKey,
        credits: pkg.rows[0].credits,
        amountMmk: pkg.rows[0].price_mmk,
        provider: input.provider,
      },
      ipAddress: input.ip ?? null,
    });

    return {
      id: intent.id,
      referenceCode: intent.reference_code,
      credits: pkg.rows[0].credits,
      amountMmk: pkg.rows[0].price_mmk,
      provider: input.provider,
      status: "awaiting_payment" as const,
      expiresAt: intent.expires_at,
    };
  });
}

/**
 * Start a plan subscription payment. Same QR + reconciliation path as a credit
 * pack — only the thing being bought differs, so buyers and reviewers learn one
 * flow rather than two.
 */
export async function createSubscriptionIntent(
  user: AuthUser,
  input: { plan: string; billingCycle: "monthly" | "annual"; provider: string; ip?: string | null }
) {
  if (!user.companyId) throw forbidden("A company context is required");

  return withContext(ctxForUser(user), async (client) => {
    const price = await client.query<{
      monthly_mmk: number;
      annual_mmk: number;
      monthly_credits: number;
      display_name: string;
    }>(
      `SELECT monthly_mmk, annual_mmk, monthly_credits, display_name
         FROM plan_prices WHERE plan = $1 AND active`,
      [input.plan]
    );
    if (!price.rows[0]) throw badRequest("Unknown or inactive plan");

    const method = await client.query(
      `SELECT 1 FROM payment_methods WHERE provider = $1 AND active`,
      [input.provider]
    );
    if (method.rowCount === 0) throw badRequest("That payment method is not available");

    const months = input.billingCycle === "annual" ? 12 : 1;
    const amount =
      input.billingCycle === "annual" ? price.rows[0].annual_mmk : price.rows[0].monthly_mmk;

    let created;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        created = await client.query<{ id: string; reference_code: string; expires_at: string }>(
          `INSERT INTO payment_intents
             (company_id, created_by, kind, plan, billing_cycle, period_months,
              credits, amount_mmk, provider, reference_code, expires_at)
           VALUES ($1, $2, 'subscription', $3, $4, $5, 0, $6, $7, $8,
                   now() + make_interval(hours => $9))
           RETURNING id, reference_code, expires_at`,
          [
            user.companyId,
            user.id,
            input.plan,
            input.billingCycle,
            months,
            amount,
            input.provider,
            generateReferenceCode(),
            INTENT_TTL_HOURS,
          ]
        );
        break;
      } catch (err) {
        if (!isUniqueViolation(err) || attempt === 4) throw err;
      }
    }

    const intent = created!.rows[0]!;
    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "payment.intent_created",
      resourceType: "payment_intent",
      resourceId: intent.id,
      metadata: {
        kind: "subscription",
        plan: input.plan,
        billingCycle: input.billingCycle,
        amountMmk: amount,
      },
      ipAddress: input.ip ?? null,
    });

    return {
      id: intent.id,
      referenceCode: intent.reference_code,
      kind: "subscription" as const,
      plan: input.plan,
      planName: price.rows[0].display_name,
      billingCycle: input.billingCycle,
      monthlyCredits: price.rows[0].monthly_credits,
      credits: 0,
      amountMmk: amount,
      provider: input.provider,
      status: "awaiting_payment" as const,
      expiresAt: intent.expires_at,
    };
  });
}

export interface ProofUpload {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/**
 * The buyer declares they have paid: their wallet transaction id, optionally a
 * screenshot. This does NOT grant credits — it moves the intent onto the
 * reconciliation queue.
 */
export async function submitPaymentProof(
  user: AuthUser,
  intentId: string,
  input: { payerReference: string; payerNote?: string; proof?: ProofUpload; ip?: string | null }
) {
  if (input.proof && !ALLOWED_PROOF_TYPES.has(input.proof.mimetype)) {
    throw badRequest("Payment proof must be a JPEG, PNG, or PDF");
  }

  return withContext(ctxForUser(user), async (client) => {
    const intent = await client.query<{ status: string; expires_at: string; provider: string }>(
      `SELECT status, expires_at, provider FROM payment_intents WHERE id = $1`,
      [intentId]
    );
    if (!intent.rows[0]) throw notFound("Payment not found");
    if (intent.rows[0].status !== "awaiting_payment") {
      throw conflict(`This payment is already ${intent.rows[0].status}`);
    }
    if (new Date(intent.rows[0].expires_at) <= new Date()) {
      throw conflict("This payment request has expired — start a new one");
    }

    let proofRef: string | null = null;
    if (input.proof) {
      proofRef = `payment-proof/${intentId}/${randomBytes(8).toString("hex")}`;
      await putObject(proofRef, input.proof.buffer, input.proof.mimetype);
    }

    try {
      await client.query(
        `UPDATE payment_intents
            SET status = 'submitted', payer_reference = $2, payer_note = $3,
                proof_storage_ref = $4, submitted_at = now()
          WHERE id = $1`,
        [intentId, input.payerReference.trim(), input.payerNote ?? null, proofRef]
      );
    } catch (err) {
      // The unique index on (provider, payer_reference) fired: this wallet
      // transaction has already been claimed, here or by another company.
      if (isUniqueViolation(err)) {
        throw conflict(
          "That transaction number has already been submitted. Check the number, or contact support if you believe this is an error."
        );
      }
      throw err;
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "user",
      action: "payment.proof_submitted",
      resourceType: "payment_intent",
      resourceId: intentId,
      metadata: { hasScreenshot: Boolean(proofRef) },
      ipAddress: input.ip ?? null,
    });
    return { id: intentId, status: "submitted" as const };
  });
}

export async function listOwnPayments(user: AuthUser) {
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query(
      `SELECT id, reference_code, receipt_number, credits, amount_mmk, provider, status,
              kind, plan, billing_cycle,
              payer_reference, decision_note, created_at, expires_at, decided_at
         FROM payment_intents
        ORDER BY created_at DESC LIMIT 50`
    );
    return res.rows.map((r) => ({
      id: r.id,
      referenceCode: r.reference_code,
      receiptNumber: r.receipt_number,
      kind: r.kind,
      plan: r.plan,
      billingCycle: r.billing_cycle,
      credits: r.credits,
      amountMmk: r.amount_mmk,
      provider: r.provider,
      status: r.status,
      payerReference: r.payer_reference,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
    }));
  });
}

// --- Admin: reconciliation ------------------------------------------------------

export async function listPaymentsForReview(admin: AuthUser, status = "submitted") {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query(
      `SELECT p.id, p.reference_code, p.credits, p.amount_mmk, p.provider, p.status,
              p.kind, p.plan, p.billing_cycle,
              p.payer_reference, p.payer_note, p.proof_storage_ref,
              p.submitted_at, p.created_at,
              c.legal_name AS company_name, c.id AS company_id
         FROM payment_intents p
         JOIN companies c ON c.id = p.company_id
        WHERE p.status = $1
        ORDER BY p.submitted_at NULLS LAST, p.created_at
        LIMIT 100`,
      [status]
    );
    return res.rows.map((r) => ({
      id: r.id,
      referenceCode: r.reference_code,
      kind: r.kind,
      plan: r.plan,
      billingCycle: r.billing_cycle,
      credits: r.credits,
      amountMmk: r.amount_mmk,
      provider: r.provider,
      status: r.status,
      payerReference: r.payer_reference,
      payerNote: r.payer_note,
      hasProof: Boolean(r.proof_storage_ref),
      companyId: r.company_id,
      companyName: r.company_name,
      submittedAt: r.submitted_at,
      createdAt: r.created_at,
    }));
  });
}

/** Presigned view of the buyer's screenshot. Audited — it is payment evidence. */
export async function getPaymentProofUrl(admin: AuthUser, intentId: string, ip?: string | null) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{ proof_storage_ref: string | null }>(
      `SELECT proof_storage_ref FROM payment_intents WHERE id = $1`,
      [intentId]
    );
    if (!res.rows[0]) throw notFound("Payment not found");
    if (!res.rows[0].proof_storage_ref) throw notFound("No screenshot was attached");

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "payment.proof_view",
      resourceType: "payment_intent",
      resourceId: intentId,
      ipAddress: ip ?? null,
    });
    return { url: await presignGet(res.rows[0].proof_storage_ref) };
  });
}

/**
 * Confirm or reject a payment after checking the wallet statement.
 *
 * Confirming is the ONLY thing that creates credits, and it happens in the same
 * transaction as the status change, so a company can never be marked paid
 * without the credits landing (or vice versa). Re-deciding is refused by the
 * status guard, so a double-click cannot grant twice.
 */
export async function decidePayment(
  admin: AuthUser,
  intentId: string,
  input: { decision: "confirm" | "reject"; note: string; ip?: string | null }
) {
  return withContext(ctxForUser(admin), async (client) => {
    const res = await client.query<{
      company_id: string;
      credits: number;
      amount_mmk: number;
      status: string;
      reference_code: string;
      kind: string;
      plan: string | null;
      billing_cycle: string | null;
      period_months: number | null;
    }>(
      `SELECT company_id, credits, amount_mmk, status, reference_code,
              kind, plan, billing_cycle, period_months
         FROM payment_intents WHERE id = $1 FOR UPDATE`,
      [intentId]
    );
    if (!res.rows[0]) throw notFound("Payment not found");
    if (res.rows[0].status !== "submitted") {
      throw conflict(`This payment is ${res.rows[0].status}, not awaiting confirmation`);
    }

    if (input.decision === "reject") {
      await client.query(
        `UPDATE payment_intents
            SET status = 'rejected', decided_at = now(), decided_by = $2, decision_note = $3
          WHERE id = $1`,
        [intentId, admin.id, input.note]
      );
      await notify(client, {
        companyId: res.rows[0].company_id,
        kind: "payment.rejected",
        params: { referenceCode: res.rows[0].reference_code, reason: input.note },
        severity: "error",
        link: "/billing",
      });

      await writeAudit(client, {
        actorId: admin.id,
        actorType: "admin",
        action: "payment.rejected",
        resourceType: "payment_intent",
        resourceId: intentId,
        metadata: { reason: input.note, referenceCode: res.rows[0].reference_code },
        ipAddress: input.ip ?? null,
      });
      return { id: intentId, status: "rejected" as const };
    }

    if (res.rows[0].kind === "subscription") {
      return confirmSubscription(client, admin, intentId, res.rows[0], input);
    }

    const balance = await grantCredits(client, {
      companyId: res.rows[0].company_id,
      amount: res.rows[0].credits,
      reason: "purchase",
      action: "grant.purchase",
      resourceType: "payment_intent",
      resourceId: intentId,
      actorUserId: admin.id,
      metadata: {
        referenceCode: res.rows[0].reference_code,
        amountMmk: res.rows[0].amount_mmk,
      },
    });

    const lot = await client.query<{ id: string }>(
      `SELECT id FROM credit_lots WHERE company_id = $1 ORDER BY granted_at DESC LIMIT 1`,
      [res.rows[0].company_id]
    );
    // The receipt number is minted here, at confirmation, and never before:
    // a receipt for a payment nobody has verified is exactly the document a
    // company should not be able to produce.
    const receipt = await client.query<{ receipt_number: string }>(
      `UPDATE payment_intents
          SET status = 'confirmed', decided_at = now(), decided_by = $2,
              decision_note = $3, credit_lot_id = $4,
              receipt_number = COALESCE(receipt_number, $5)
        WHERE id = $1
        RETURNING receipt_number`,
      [intentId, admin.id, input.note, lot.rows[0]?.id ?? null, await nextReceiptNumber(client)]
    );

    await notify(client, {
      companyId: res.rows[0].company_id,
      kind: "payment.confirmed",
      params: { credits: res.rows[0].credits, referenceCode: res.rows[0].reference_code },
      severity: "success",
      link: "/billing",
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "payment.confirmed",
      resourceType: "payment_intent",
      resourceId: intentId,
      metadata: {
        kind: "credit_pack",
        referenceCode: res.rows[0].reference_code,
        credits: res.rows[0].credits,
        amountMmk: res.rows[0].amount_mmk,
      },
      ipAddress: input.ip ?? null,
    });
    return {
      id: intentId,
      status: "confirmed" as const,
      credits: res.rows[0].credits,
      receiptNumber: receipt.rows[0]?.receipt_number ?? null,
      balance,
    };
  });
}

/**
 * Turn a confirmed subscription payment into a paid period.
 *
 * A renewal EXTENDS the current period rather than restarting it from today —
 * paying early must not cost the buyer the days they already hold. The first
 * month's bundled credits are granted immediately so the plan is usable the
 * moment it is paid; later months come from the monthly sweep.
 */
async function confirmSubscription(
  client: PoolClient,
  admin: AuthUser,
  intentId: string,
  intent: {
    company_id: string;
    plan: string | null;
    billing_cycle: string | null;
    period_months: number | null;
    amount_mmk: number;
    reference_code: string;
  },
  input: { note: string; ip?: string | null }
) {
  const price = await client.query<{ monthly_credits: number }>(
    `SELECT monthly_credits FROM plan_prices WHERE plan = $1`,
    [intent.plan]
  );

  const period = await client.query<{ id: string; starts_at: string; ends_at: string }>(
    `INSERT INTO company_plan_periods
       (company_id, plan, billing_cycle, starts_at, ends_at, payment_intent_id)
     VALUES (
       $1, $2, $3,
       -- Start now, or where the current period ends if one is still running.
       GREATEST(now(), COALESCE(
         (SELECT max(ends_at) FROM company_plan_periods
           WHERE company_id = $1 AND ends_at > now()), now())),
       GREATEST(now(), COALESCE(
         (SELECT max(ends_at) FROM company_plan_periods
           WHERE company_id = $1 AND ends_at > now()), now()))
         + make_interval(months => $4),
       $5
     )
     RETURNING id, starts_at, ends_at`,
    [intent.company_id, intent.plan, intent.billing_cycle, intent.period_months, intentId]
  );

  await client.query(`UPDATE companies SET plan = $2 WHERE id = $1`, [
    intent.company_id,
    intent.plan,
  ]);

  // Credits for the current month, up front, so the plan is usable the moment
  // it is paid rather than waiting for the next sweep.
  //
  // Skipped when this month's grant already exists — renewing early, or moving
  // plan mid-month, must not hand out a second month's credits. (Without this
  // the one-grant-per-month index in 0013 raises and the confirmation fails,
  // leaving the payment stuck.) Subsequent months come from the sweep.
  const monthlyCredits = price.rows[0]?.monthly_credits ?? 0;
  const alreadyGranted = await client.query(
    `SELECT 1 FROM credit_lots
      WHERE company_id = $1 AND reason = 'monthly_grant'
        AND date_trunc('month', granted_at AT TIME ZONE 'UTC')
            = date_trunc('month', now() AT TIME ZONE 'UTC')
      LIMIT 1`,
    [intent.company_id]
  );

  let balance = await getBalance(client, intent.company_id);
  if (monthlyCredits > 0 && alreadyGranted.rowCount === 0) {
    balance = await grantCredits(client, {
      companyId: intent.company_id,
      amount: monthlyCredits,
      reason: "monthly_grant",
      action: "grant.monthly",
      resourceType: "payment_intent",
      resourceId: intentId,
      actorUserId: admin.id,
      metadata: { plan: intent.plan, firstPeriod: true },
    });
  }

  const receipt = await client.query<{ receipt_number: string }>(
    `UPDATE payment_intents
        SET status = 'confirmed', decided_at = now(), decided_by = $2, decision_note = $3,
            receipt_number = COALESCE(receipt_number, $4)
      WHERE id = $1
      RETURNING receipt_number`,
    [intentId, admin.id, input.note, await nextReceiptNumber(client)]
  );

  await writeAudit(client, {
    actorId: admin.id,
    actorType: "admin",
    action: "payment.confirmed",
    resourceType: "payment_intent",
    resourceId: intentId,
    metadata: {
      kind: "subscription",
      referenceCode: intent.reference_code,
      plan: intent.plan,
      billingCycle: intent.billing_cycle,
      amountMmk: intent.amount_mmk,
      periodEndsAt: period.rows[0]!.ends_at,
    },
    ipAddress: input.ip ?? null,
  });

  return {
    id: intentId,
    status: "confirmed" as const,
    plan: intent.plan,
    periodEndsAt: period.rows[0]!.ends_at,
    credits: monthlyCredits,
    receiptNumber: receipt.rows[0]?.receipt_number ?? null,
    balance,
  };
}

// --- Admin: manage the QR / account details ------------------------------------

export async function upsertPaymentMethod(
  admin: AuthUser,
  input: {
    provider: string;
    displayName: string;
    accountName: string;
    accountNumber: string;
    instructions?: string;
    active: boolean;
    qr?: ProofUpload;
    ip?: string | null;
  }
) {
  if (input.qr && !ALLOWED_PROOF_TYPES.has(input.qr.mimetype)) {
    throw badRequest("QR image must be a JPEG, PNG, or PDF");
  }

  return withContext(ctxForUser(admin), async (client) => {
    let qrRef: string | null = null;
    if (input.qr) {
      qrRef = `payment-qr/${input.provider}/${randomBytes(8).toString("hex")}`;
      await putObject(qrRef, input.qr.buffer, input.qr.mimetype);
    }

    await client.query(
      `INSERT INTO payment_methods
         (provider, display_name, account_name, account_number, instructions, active, qr_storage_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider) DO UPDATE
         SET display_name   = EXCLUDED.display_name,
             account_name   = EXCLUDED.account_name,
             account_number = EXCLUDED.account_number,
             instructions   = EXCLUDED.instructions,
             active         = EXCLUDED.active,
             -- Keep the existing QR when this update did not carry a new one.
             qr_storage_ref = COALESCE(EXCLUDED.qr_storage_ref, payment_methods.qr_storage_ref)`,
      [
        input.provider,
        input.displayName,
        input.accountName,
        input.accountNumber,
        input.instructions ?? null,
        input.active,
        qrRef,
      ]
    );

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "payment_method.upsert",
      resourceType: "payment_method",
      metadata: { provider: input.provider, active: input.active, qrReplaced: Boolean(qrRef) },
      ipAddress: input.ip ?? null,
    });
    return { provider: input.provider };
  });
}

/** Lapse intents nobody paid, so the queue and the codes stay meaningful. */
export async function expirePaymentIntents(): Promise<number> {
  return withContext({ userType: "system" }, async (client) => {
    const res = await client.query(
      `UPDATE payment_intents SET status = 'expired'
        WHERE status = 'awaiting_payment' AND expires_at <= now()`
    );
    return res.rowCount ?? 0;
  });
}
