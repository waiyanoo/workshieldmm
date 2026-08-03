/**
 * Receipts.
 *
 * A receipt is a rendering of a payment that has already been reconciled, not a
 * new record — everything on it is read from `payment_intents`, the company row,
 * and the credit lot the confirmation created. There is deliberately nothing to
 * write here: a document a customer can produce, but not alter, is the point.
 *
 * Two consequences worth naming:
 *
 *   - Only CONFIRMED payments have receipts. An intent that is awaiting payment,
 *     submitted, rejected or expired returns 404 rather than a receipt marked
 *     "unpaid" — a company should not be able to generate a plausible-looking
 *     document for money the platform never confirmed receiving.
 *   - The credit lot is joined in, so the receipt states when what was bought
 *     stops being usable. Credits expire (welcome 1 month, monthly 3, purchase
 *     6 — migration 0018), and an expiry date that only appears in the app is
 *     the kind of term customers rightly complain they were never shown.
 *
 * This is a receipt — proof of a payment received — and is labelled as such,
 * not as a tax invoice. Issuing one means matching Myanmar commercial-tax
 * requirements (seller tax identification, the applicable rate, the prescribed
 * serial format), and that is a decision for the business, not a template.
 */
import { withContext, type AppContext } from "../../db/pool";
import { forbidden, notFound } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

const PROVIDER_LABELS: Record<string, string> = {
  mmqr: "MMQR",
  kbzpay: "KBZPay",
  wavepay: "Wave Pay",
  bank_transfer: "Bank transfer",
};

export async function getReceipt(user: AuthUser, intentId: string) {
  if (!user.companyId && user.userType !== "platform") {
    throw forbidden("A company context is required");
  }

  return withContext(ctxForUser(user), async (client) => {
    // RLS scopes this to the caller's own company; platform staff see all, which
    // is what lets support re-send a receipt a customer has lost.
    const res = await client.query<{
      id: string;
      receipt_number: string | null;
      reference_code: string;
      payer_reference: string | null;
      kind: string;
      plan: string | null;
      billing_cycle: string | null;
      credits: number;
      amount_mmk: number;
      list_amount_mmk: number | null;
      discount_percent: number;
      provider: string;
      status: string;
      created_at: string;
      decided_at: string | null;
      company_name: string;
      registration_number: string;
      address_line: string | null;
      township: string | null;
      city: string | null;
      region: string | null;
      contact_email: string | null;
      phone: string | null;
      buyer_name: string | null;
      lot_expires_at: string | null;
      lot_remaining: number | null;
      plan_name: string | null;
      period_starts_at: string | null;
      period_ends_at: string | null;
    }>(
      `SELECT p.id, p.receipt_number, p.reference_code, p.payer_reference,
              p.kind, p.plan, p.billing_cycle, p.credits, p.amount_mmk,
              p.list_amount_mmk, p.discount_percent,
              p.provider, p.status, p.created_at, p.decided_at,
              c.legal_name AS company_name, c.registration_number,
              c.address_line, c.township, c.city, c.region,
              c.contact_email, c.phone,
              u.full_name AS buyer_name,
              l.expires_at AS lot_expires_at, l.remaining AS lot_remaining,
              pp.display_name AS plan_name,
              per.starts_at AS period_starts_at, per.ends_at AS period_ends_at
         FROM payment_intents p
         JOIN companies c ON c.id = p.company_id
         LEFT JOIN company_users u ON u.id = p.created_by
         LEFT JOIN credit_lots l ON l.id = p.credit_lot_id
         LEFT JOIN plan_prices pp ON pp.plan = p.plan
         LEFT JOIN company_plan_periods per ON per.payment_intent_id = p.id
        WHERE p.id = $1`,
      [intentId]
    );
    const r = res.rows[0];
    if (!r) throw notFound("Payment not found");
    if (r.status !== "confirmed") {
      throw notFound("There is no receipt for this payment — it has not been confirmed");
    }

    const isSubscription = r.kind === "subscription";

    return {
      receiptNumber: r.receipt_number,
      // The code the buyer put in the transfer note. Kept on the receipt so a
      // customer querying a charge with their bank has the same string we do.
      referenceCode: r.reference_code,
      payerReference: r.payer_reference,
      issuedAt: r.decided_at,
      orderedAt: r.created_at,
      paidBy: {
        companyName: r.company_name,
        registrationNumber: r.registration_number,
        address: [r.address_line, r.township, r.city, r.region].filter(Boolean).join(", ") || null,
        contactEmail: r.contact_email,
        phone: r.phone,
        purchasedByName: r.buyer_name,
      },
      // A single line item: every intent buys exactly one thing. Modelled as a
      // list anyway so a receipt template written now survives the day an order
      // can hold two.
      lines: [
        {
          kind: r.kind,
          description: isSubscription
            ? `${r.plan_name ?? r.plan} plan — ${r.billing_cycle === "annual" ? "12 months" : "1 month"}`
            : `${r.credits} credits`,
          credits: isSubscription ? null : r.credits,
          // The list price, not what was charged. The discount is its own line
          // below, so charging price here would subtract the discount twice and
          // leave a receipt whose lines do not add up to its total.
          amountMmk: r.list_amount_mmk ?? r.amount_mmk,
        },
      ],
      // A customer comparing two invoices months apart should be able to see
      // why they differ, so the discount stays on the document.
      discount:
        r.discount_percent > 0 && r.list_amount_mmk
          ? {
              percentOff: r.discount_percent,
              listMmk: r.list_amount_mmk,
              savedMmk: r.list_amount_mmk - r.amount_mmk,
            }
          : null,
      totalMmk: r.amount_mmk,
      currency: "MMK",
      payment: {
        method: PROVIDER_LABELS[r.provider] ?? r.provider,
        provider: r.provider,
        status: r.status,
      },
      // What was actually received, and until when.
      credits: isSubscription
        ? null
        : {
            purchased: r.credits,
            remaining: r.lot_remaining,
            expiresAt: r.lot_expires_at,
          },
      subscription: isSubscription
        ? {
            plan: r.plan,
            planName: r.plan_name,
            billingCycle: r.billing_cycle,
            periodStartsAt: r.period_starts_at,
            // The renewal date, which is the thing customers open a receipt to
            // check more often than the amount.
            renewsAt: r.period_ends_at,
          }
        : null,
    };
  });
}
