/**
 * Administering promotions. Super Admin only.
 *
 * A promotion changes what every company is charged, so this is deliberately
 * small: schedule one, correct it, or end it. There is no delete — a promotion
 * that has priced a payment is part of the record behind that payment's
 * receipt, and removing it would leave receipts explaining a discount that no
 * longer exists anywhere.
 *
 * Editing never reprices money already in flight. Payment intents freeze their
 * own list price, discount and promotion id when they are created, so changing
 * a percentage here moves the next quote and nothing that has been quoted.
 */
import type { PoolClient } from "pg";
import { withContext, type AppContext } from "../../db/pool";
import { writeAudit } from "../../lib/audit";
import { badRequest, conflict, notFound, promotionOverlap } from "../../lib/errors";
import { isCheckViolation, isExclusionViolation } from "../../lib/dbErrors";
import type { AuthUser } from "../../types/auth";

function ctxForUser(user: AuthUser): AppContext {
  return { userType: user.userType, userId: user.id, companyId: user.companyId };
}

export interface PromotionRow {
  id: string;
  name: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
  /** Where this sits relative to now — the one thing the screen sorts on. */
  state: "scheduled" | "running" | "ended";
  /** Payments priced by it, so ending one is an informed decision. */
  paymentsPriced: number;
  amountMmk: number;
  discountGivenMmk: number;
}

const SELECT = `
  SELECT p.id, p.name, p.percent_off, p.starts_at, p.ends_at, p.active, p.created_at,
         COALESCE(u.payments, 0) AS payments,
         COALESCE(u.amount_mmk, 0) AS amount_mmk,
         COALESCE(u.discount_mmk, 0) AS discount_mmk
    FROM pricing_promotions p
    LEFT JOIN (
      SELECT promotion_id,
             count(*) AS payments,
             sum(amount_mmk) AS amount_mmk,
             sum(COALESCE(list_amount_mmk, amount_mmk) - amount_mmk) AS discount_mmk
        FROM payment_intents
       WHERE promotion_id IS NOT NULL AND status = 'confirmed'
       GROUP BY promotion_id
    ) u ON u.promotion_id = p.id`;

interface Raw {
  id: string;
  name: string;
  percent_off: number;
  starts_at: string;
  ends_at: string;
  active: boolean;
  created_at: string;
  payments: string;
  amount_mmk: string;
  discount_mmk: string;
}

function toRow(r: Raw): PromotionRow {
  const now = Date.now();
  const starts = new Date(r.starts_at).getTime();
  const ends = new Date(r.ends_at).getTime();
  // "Ended" covers a cancelled promotion too: from a buyer's point of view an
  // inactive promotion and an expired one are the same thing — not on offer.
  const state: PromotionRow["state"] =
    !r.active || now >= ends ? "ended" : now < starts ? "scheduled" : "running";
  return {
    id: r.id,
    name: r.name,
    percentOff: r.percent_off,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    active: r.active,
    createdAt: r.created_at,
    state,
    paymentsPriced: Number(r.payments),
    amountMmk: Number(r.amount_mmk),
    discountGivenMmk: Number(r.discount_mmk),
  };
}

export async function listPromotions(user: AuthUser): Promise<{ items: PromotionRow[] }> {
  return withContext(ctxForUser(user), async (client) => {
    const res = await client.query<Raw>(`${SELECT} ORDER BY p.starts_at DESC`);
    return { items: res.rows.map(toRow) };
  });
}

async function loadOne(client: PoolClient, id: string): Promise<PromotionRow> {
  const res = await client.query<Raw>(`${SELECT} WHERE p.id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound("Promotion not found");
  return toRow(row);
}

/** Turn the database's constraint names into something an operator can act on. */
function rethrowWriteError(err: unknown): never {
  if (isExclusionViolation(err)) throw promotionOverlap();
  if (isCheckViolation(err)) {
    throw badRequest("The end date must be after the start date, and the discount must be 1-99%.");
  }
  throw err;
}

export interface PromotionInput {
  name: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
  ip?: string | null;
}

export async function createPromotion(
  user: AuthUser,
  input: PromotionInput
): Promise<PromotionRow> {
  if (new Date(input.endsAt) <= new Date(input.startsAt)) {
    throw badRequest("The end date must be after the start date.");
  }
  return withContext(ctxForUser(user), async (client) => {
    let id: string;
    try {
      const res = await client.query<{ id: string }>(
        `INSERT INTO pricing_promotions (name, percent_off, starts_at, ends_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.percentOff, input.startsAt, input.endsAt]
      );
      id = res.rows[0]!.id;
    } catch (err) {
      rethrowWriteError(err);
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "admin",
      action: "promotion.created",
      resourceType: "pricing_promotion",
      resourceId: id,
      metadata: {
        name: input.name,
        percentOff: input.percentOff,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
      ipAddress: input.ip ?? null,
    });
    return loadOne(client, id);
  });
}

export async function updatePromotion(
  user: AuthUser,
  id: string,
  patch: Partial<Omit<PromotionInput, "ip">> & { ip?: string | null }
): Promise<PromotionRow> {
  return withContext(ctxForUser(user), async (client) => {
    const before = await loadOne(client, id);
    if (before.state === "ended") {
      // Reopening a finished promotion would change the meaning of receipts
      // already issued under it. Schedule a new one instead.
      throw conflict("This promotion has ended. Create a new one rather than reopening it.");
    }

    const startsAt = patch.startsAt ?? before.startsAt;
    const endsAt = patch.endsAt ?? before.endsAt;
    if (new Date(endsAt) <= new Date(startsAt)) {
      throw badRequest("The end date must be after the start date.");
    }
    // Moving the start of something already running would rewrite when it began.
    if (before.state === "running" && patch.startsAt && patch.startsAt !== before.startsAt) {
      throw badRequest("A promotion that has already started cannot have its start date moved.");
    }

    try {
      await client.query(
        `UPDATE pricing_promotions
            SET name = $2, percent_off = $3, starts_at = $4, ends_at = $5
          WHERE id = $1`,
        [id, patch.name ?? before.name, patch.percentOff ?? before.percentOff, startsAt, endsAt]
      );
    } catch (err) {
      rethrowWriteError(err);
    }

    await writeAudit(client, {
      actorId: user.id,
      actorType: "admin",
      action: "promotion.updated",
      resourceType: "pricing_promotion",
      resourceId: id,
      metadata: {
        before: {
          name: before.name,
          percentOff: before.percentOff,
          startsAt: before.startsAt,
          endsAt: before.endsAt,
        },
        after: {
          name: patch.name ?? before.name,
          percentOff: patch.percentOff ?? before.percentOff,
          startsAt,
          endsAt,
        },
      },
      ipAddress: patch.ip ?? null,
    });
    return loadOne(client, id);
  });
}

/**
 * Stop offering a promotion.
 *
 * A running one is closed at this moment rather than deleted, so the window it
 * actually covered stays on the record; one that never started is simply
 * cancelled, because it has no window to close. Either way `active` goes false,
 * which is what pricing reads — and what frees the dates for the next offer.
 */
export async function endPromotion(
  user: AuthUser,
  id: string,
  ip?: string | null
): Promise<PromotionRow> {
  return withContext(ctxForUser(user), async (client) => {
    const before = await loadOne(client, id);
    if (before.state === "ended") throw conflict("This promotion is already over.");

    await client.query(
      `UPDATE pricing_promotions
          SET active = false,
              ends_at = CASE WHEN now() > starts_at THEN now() ELSE ends_at END
        WHERE id = $1`,
      [id]
    );
    await writeAudit(client, {
      actorId: user.id,
      actorType: "admin",
      action: before.state === "running" ? "promotion.ended" : "promotion.cancelled",
      resourceType: "pricing_promotion",
      resourceId: id,
      metadata: { name: before.name, percentOff: before.percentOff, endsAt: before.endsAt },
      ipAddress: ip ?? null,
    });
    return loadOne(client, id);
  });
}
