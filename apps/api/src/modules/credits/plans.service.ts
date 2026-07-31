/**
 * Plan changes, top-ups, and the monthly credit grant. (Pricing Plan §3, §4)
 */
import type { PoolClient } from "pg";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { notFound } from "../../lib/errors";
import type { AuthUser } from "../../types/auth";
import {
  CREDIT_LIFETIME_MONTHS,
  getBalance,
  grantCredits,
  monthlyCreditsFor,
} from "./credits.service";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export async function setCompanyPlan(
  admin: AuthUser,
  companyId: string,
  input: {
    plan: string;
    monthlyCreditOverride: number | null;
    reason: string;
    ip?: string | null;
  }
) {
  return withContext(ctxForUser(admin), async (client) => {
    const before = await client.query<{ plan: string }>(
      `SELECT plan FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!before.rows[0]) throw notFound("Company not found");

    await client.query(
      `UPDATE companies SET plan = $2, monthly_credit_override = $3 WHERE id = $1`,
      [companyId, input.plan, input.monthlyCreditOverride]
    );

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "company.plan_change",
      resourceType: "company",
      resourceId: companyId,
      metadata: {
        from: before.rows[0].plan,
        to: input.plan,
        monthlyCreditOverride: input.monthlyCreditOverride,
        reason: input.reason,
      },
      ipAddress: input.ip ?? null,
    });

    return {
      companyId,
      plan: input.plan,
      monthlyCreditOverride: input.monthlyCreditOverride,
      balance: await getBalance(client, companyId),
    };
  });
}

/**
 * Manual credit top-up. Stands in for "Buy credits" until a payment partner is
 * wired up — §7 of the pricing plan lists that as an open item, so settlement
 * is confirmed out of band and a Super Admin records the purchase here.
 */
export async function topUpCredits(
  admin: AuthUser,
  companyId: string,
  input: { amount: number; reason: string; ip?: string | null }
) {
  return withContext(ctxForUser(admin), async (client) => {
    const exists = await client.query(`SELECT 1 FROM companies WHERE id = $1`, [companyId]);
    if (exists.rowCount === 0) throw notFound("Company not found");

    const balance = await grantCredits(client, {
      companyId,
      amount: input.amount,
      reason: "purchase",
      action: "grant.purchase",
      actorUserId: admin.id,
      metadata: { reason: input.reason },
    });

    await writeAudit(client, {
      actorId: admin.id,
      actorType: "admin",
      action: "credits.topup",
      resourceType: "company",
      resourceId: companyId,
      metadata: { amount: input.amount, reason: input.reason },
      ipAddress: input.ip ?? null,
    });
    return { companyId, granted: input.amount, balance };
  });
}

/** Welcome credits on registration. Runs in the registration transaction. */
export async function grantWelcomeCredits(
  client: PoolClient,
  companyId: string,
  amount: number
): Promise<void> {
  await grantCredits(client, {
    companyId,
    amount,
    reason: "welcome",
    action: "grant.welcome",
  });
}

/**
 * Monthly bundled-credit grant for every company on a paying plan.
 *
 * Idempotent by construction: the unique index in 0013 allows one
 * `monthly_grant` lot per company per calendar month, so a retried or
 * double-scheduled sweep cannot mint a second month's credits. Conflicts are
 * skipped rather than raised.
 */
export async function grantMonthlyCredits(): Promise<{ companyId: string; amount: number }[]> {
  return withContext({ userType: "system" }, async (client) => {
    // Only companies with a LIVE PAID PERIOD receive bundled credits. Before
    // 0015 this read the plan column alone, which meant an admin setting a plan
    // by hand minted credits every month with no payment behind it.
    const companies = await client.query<{
      id: string;
      plan: string;
      monthly_credit_override: number | null;
    }>(
      `SELECT c.id, c.plan, c.monthly_credit_override
         FROM companies c
        WHERE c.status = 'verified'
          AND EXISTS (
            SELECT 1 FROM company_plan_periods p
             WHERE p.company_id = c.id AND p.ends_at > now()
          )`
    );

    const granted: { companyId: string; amount: number }[] = [];
    for (const c of companies.rows) {
      const amount = monthlyCreditsFor(c.plan, c.monthly_credit_override);
      if (amount <= 0) continue;

      // ON CONFLICT DO NOTHING against the one-per-month index: if this month's
      // grant already exists, no row comes back and we skip the ledger entry.
      // The allowance rolls over for 3 months. (Pricing Plan §4, 0018)
      const lot = await client.query<{ id: string }>(
        `INSERT INTO credit_lots (company_id, amount, remaining, reason, expires_at)
         VALUES ($1, $2, $2, 'monthly_grant',
                 now() + make_interval(months => $3))
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [c.id, amount, CREDIT_LIFETIME_MONTHS.monthly_grant]
      );
      if (!lot.rows[0]) continue;

      await client.query(
        `INSERT INTO credit_ledger (company_id, delta, action, lot_id, metadata)
         VALUES ($1, $2, 'grant.monthly', $3, $4)`,
        [c.id, amount, lot.rows[0].id, JSON.stringify({ plan: c.plan })]
      );
      await writeAudit(client, {
        actorType: "system",
        action: "credits.monthly_grant",
        resourceType: "company",
        resourceId: c.id,
        metadata: { plan: c.plan, amount },
      });
      granted.push({ companyId: c.id, amount });
    }
    return granted;
  });
}

/**
 * Drop companies back to Free when their paid period ends.
 *
 * Deliberately does not touch the credit balance: credits already granted were
 * paid for and keep their own expiry. Losing the plan stops future bundled
 * grants, it does not confiscate what is already owned.
 */
export async function lapseExpiredPlans(): Promise<number> {
  return withContext({ userType: "system" }, async (client) => {
    const lapsed = await client.query<{ id: string; plan: string }>(
      `UPDATE companies c
          SET plan = 'free', monthly_credit_override = NULL
        WHERE c.plan <> 'free'
          AND NOT EXISTS (
            SELECT 1 FROM company_plan_periods p
             WHERE p.company_id = c.id AND p.ends_at > now()
          )
        RETURNING c.id, c.plan`
    );
    for (const row of lapsed.rows) {
      await writeAudit(client, {
        actorType: "system",
        action: "company.plan_lapsed",
        resourceType: "company",
        resourceId: row.id,
        metadata: { reason: "paid period ended" },
      });
    }
    return lapsed.rows.length;
  });
}

/**
 * Expire credits past their lifetime — 1 month for welcome credits, 3 for the
 * plan allowance and earned credits, 6 for purchases. (0018)
 *
 * Zeroing `remaining` is what actually removes them from the balance; the
 * ledger row exists so a customer can see what lapsed and when, rather than
 * finding the number quietly smaller.
 */
export async function expireCredits(): Promise<number> {
  return withContext({ userType: "system" }, async (client) => {
    const lapsed = await client.query<{ id: string; company_id: string; remaining: number }>(
      `SELECT id, company_id, remaining
         FROM credit_lots
        WHERE remaining > 0 AND expires_at <= now()
        FOR UPDATE`
    );

    for (const lot of lapsed.rows) {
      await client.query(`UPDATE credit_lots SET remaining = 0 WHERE id = $1`, [lot.id]);
      await client.query(
        `INSERT INTO credit_ledger (company_id, delta, action, lot_id, metadata)
         VALUES ($1, $2, 'expire.rollover', $3, $4)`,
        [lot.company_id, -lot.remaining, lot.id, JSON.stringify({ reason: "expiry reached" })]
      );
    }
    return lapsed.rows.length;
  });
}
