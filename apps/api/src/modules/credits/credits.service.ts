/**
 * Credit metering. (Pricing Plan §1-§4)
 *
 * The model, in short: registration and report submission are free, plans
 * differ only in bundled credits rather than in what is unlocked, and the
 * metered actions are search / view / download / evidence pull. Accepted
 * reports earn credits back, so supplying good records offsets consumption.
 *
 * Credits live in lots (migration 0013), each with a lifetime set by where it
 * came from. A spend consumes lots earliest-expiry first, so shorter-lived
 * credits go before longer-lived ones — the free welcome allowance before the
 * plan allowance, and both before credits the company paid cash for. Every
 * movement writes a ledger row.
 *
 * All functions here take an open client and run INSIDE the caller's
 * transaction. That is deliberate — a debit and the action it paid for must
 * commit or roll back together, or a failed search still bills the customer.
 */
import type { PoolClient } from "pg";
import { paymentRequired } from "../../lib/errors";

/** Metered actions and their price. (Pricing Plan §4 Credit Usage) */
export const CREDIT_COSTS = {
  "verification.search": 5,
  "report.view": 15,
  "evidence.download": 5,
  "evidence.review": 25,
} as const;

export type MeteredAction = keyof typeof CREDIT_COSTS;

/** Credits awarded when a submitted report is accepted. (§4 Credit Earning) */
export const REPORT_ACCEPTED_REWARD = 10;

/** Monthly bundled credits by plan. Enterprise is negotiated per contract. (§3) */
export const PLAN_MONTHLY_CREDITS: Record<string, number> = {
  free: 0,
  starter: 100,
  growth: 500,
  enterprise: 0, // uses companies.monthly_credit_override
};

export const WELCOME_CREDITS = 10;

/**
 * How long credits live, by where they came from. (owner decision, 0018)
 *
 * The longer the life, the more the company gave up for them: cash buys the
 * most, an accepted record and the plan allowance the same middle amount, and
 * the free welcome allowance the least. The 3-month figure for the plan
 * allowance is Pricing Plan §4's rollover rule.
 *
 * Mirrored by the backfill in migration 0018 — change both together.
 */
export const CREDIT_LIFETIME_MONTHS: Record<GrantInput["reason"], number> = {
  welcome: 1,
  monthly_grant: 3,
  report_accepted: 3,
  purchase: 6,
  adjustment: 6,
};

export async function getBalance(client: PoolClient, companyId: string): Promise<number> {
  const res = await client.query<{ balance: string | null }>(
    `SELECT sum(remaining)::int AS balance
       FROM credit_lots
      WHERE company_id = $1 AND remaining > 0 AND expires_at > now()`,
    [companyId]
  );
  return Number(res.rows[0]?.balance ?? 0);
}

export interface GrantInput {
  companyId: string;
  amount: number;
  reason: "welcome" | "monthly_grant" | "purchase" | "report_accepted" | "adjustment";
  action: string;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
}

/** Add a lot and record it. Returns the new balance. */
export async function grantCredits(client: PoolClient, input: GrantInput): Promise<number> {
  if (input.amount <= 0) return getBalance(client, input.companyId);

  const lot = await client.query<{ id: string }>(
    `INSERT INTO credit_lots (company_id, amount, remaining, reason, expires_at)
     VALUES ($1, $2, $2, $3, now() + make_interval(months => $4))
     RETURNING id`,
    [input.companyId, input.amount, input.reason, CREDIT_LIFETIME_MONTHS[input.reason]]
  );

  await client.query(
    `INSERT INTO credit_ledger
       (company_id, delta, action, lot_id, resource_type, resource_id, actor_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.companyId,
      input.amount,
      input.action,
      lot.rows[0]!.id,
      input.resourceType ?? null,
      input.resourceId ?? null,
      input.actorUserId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return getBalance(client, input.companyId);
}

export interface SpendInput {
  companyId: string;
  action: MeteredAction;
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Charge for a metered action, or refuse it.
 *
 * Throws 402 when the balance is short — the caller's transaction rolls back,
 * so the action does not happen and nothing is billed. Lots are locked FOR
 * UPDATE so two concurrent searches cannot both spend the last credit.
 */
export async function spendCredits(
  client: PoolClient,
  input: SpendInput
): Promise<{ charged: number; balance: number }> {
  const cost = CREDIT_COSTS[input.action];

  const lots = await client.query<{ id: string; remaining: number }>(
    `SELECT id, remaining
       FROM credit_lots
      WHERE company_id = $1 AND remaining > 0 AND expires_at > now()
      ORDER BY expires_at, granted_at
      FOR UPDATE`,
    [input.companyId]
  );

  const available = lots.rows.reduce((sum, l) => sum + l.remaining, 0);
  if (available < cost) {
    throw paymentRequired(
      `This action costs ${cost} credits and your balance is ${available}. Top up or upgrade your plan to continue.`
    );
  }

  // Burn down earliest-expiring lots first, so the credits closest to lapsing
  // are used while they still can be.
  let outstanding: number = cost;
  for (const lot of lots.rows) {
    if (outstanding === 0) break;
    const take = Math.min(lot.remaining, outstanding);
    await client.query(`UPDATE credit_lots SET remaining = remaining - $2 WHERE id = $1`, [
      lot.id,
      take,
    ]);
    await client.query(
      `INSERT INTO credit_ledger
         (company_id, delta, action, lot_id, resource_type, resource_id, actor_user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.companyId,
        -take,
        input.action,
        lot.id,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.actorUserId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    outstanding -= take;
  }

  return { charged: cost, balance: await getBalance(client, input.companyId) };
}

/** Balance plus the recent movements, for the company's own usage screen. */
export async function getCreditSummary(client: PoolClient, companyId: string) {
  const balance = await getBalance(client, companyId);

  const lots = await client.query<{ remaining: number; expires_at: string; reason: string }>(
    `SELECT remaining, expires_at, reason
       FROM credit_lots
      WHERE company_id = $1 AND remaining > 0 AND expires_at > now()
      ORDER BY expires_at`,
    [companyId]
  );

  const ledger = await client.query<{
    delta: number;
    action: string;
    created_at: string;
    resource_type: string | null;
  }>(
    `SELECT delta, action, created_at, resource_type
       FROM credit_ledger WHERE company_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 50`,
    [companyId]
  );

  return {
    balance,
    costs: CREDIT_COSTS,
    // What lapses next, so a customer can spend credits before they expire
    // rather than finding the number quietly smaller.
    expiring: lots.rows.map((l) => ({
      remaining: l.remaining,
      expiresAt: l.expires_at,
      reason: l.reason,
    })),
    recent: ledger.rows.map((e) => ({
      delta: e.delta,
      action: e.action,
      resourceType: e.resource_type,
      createdAt: e.created_at,
    })),
  };
}

/** Monthly bundled credits for a company, honouring an Enterprise override. */
export function monthlyCreditsFor(plan: string, override: number | null): number {
  if (override !== null && override !== undefined) return override;
  return PLAN_MONTHLY_CREDITS[plan] ?? 0;
}
