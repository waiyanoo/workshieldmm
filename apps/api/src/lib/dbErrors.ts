/** Postgres error-code helpers. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export function isCheckViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23514";
}

/** An EXCLUDE constraint refused the row — e.g. two promotions overlapping. */
export function isExclusionViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23P01";
}
