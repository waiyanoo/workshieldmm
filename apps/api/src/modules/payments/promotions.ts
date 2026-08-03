/**
 * Promotional pricing.
 *
 * One place decides what anything costs in kyat. The screen that quotes a price
 * and the code that charges it read the same function, because a promotion that
 * applies on the pricing page but not at checkout is worse than no promotion.
 *
 * Only MONEY is discounted here. What an action costs in CREDITS is untouched:
 * a search is 5 credits during the promotion exactly as before. Discounting
 * both would compound into a far larger giveaway than "30% off" describes.
 */
import type { PoolClient } from "pg";

export interface Promotion {
  id: string;
  name: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
}

/** The promotion in force right now, or null. At most one can be. (0026) */
export async function activePromotion(client: PoolClient): Promise<Promotion | null> {
  const res = await client.query<{
    id: string;
    name: string;
    percent_off: number;
    starts_at: string;
    ends_at: string;
  }>(
    `SELECT id, name, percent_off, starts_at, ends_at
       FROM pricing_promotions
      WHERE active AND now() >= starts_at AND now() < ends_at
      ORDER BY starts_at DESC
      LIMIT 1`
  );
  const p = res.rows[0];
  return p
    ? {
        id: p.id,
        name: p.name,
        percentOff: p.percent_off,
        startsAt: p.starts_at,
        endsAt: p.ends_at,
      }
    : null;
}

/**
 * Apply a promotion to a kyat price.
 *
 * Rounded DOWN to the nearest 50 MMK. Two reasons: the payer types this amount
 * into a wallet app by hand, and 34,900 is meaningfully easier to key and check
 * than 34,930; and rounding down means the customer is never charged more than
 * the advertised discount, which is the only direction a rounding error is
 * acceptable in.
 */
export function applyPromotion(
  listMmk: number,
  promo: Promotion | null
): { amountMmk: number; listAmountMmk: number; discountPercent: number; promotionId: string | null } {
  if (!promo) {
    return { amountMmk: listMmk, listAmountMmk: listMmk, discountPercent: 0, promotionId: null };
  }
  const discounted = Math.floor((listMmk * (100 - promo.percentOff)) / 100 / 50) * 50;
  return {
    // Never below 50 MMK: a zero-amount intent would be a payment nobody can
    // make and the CHECK on amount_mmk would reject it anyway.
    amountMmk: Math.max(50, discounted),
    listAmountMmk: listMmk,
    discountPercent: promo.percentOff,
    promotionId: promo.id,
  };
}
