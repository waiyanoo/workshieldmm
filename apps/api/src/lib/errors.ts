/**
 * Typed application errors. Route handlers throw these; the central error
 * middleware turns them into safe JSON responses. Never leak internal details
 * (stack traces, SQL) to clients.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new AppError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Authentication required") =>
  new AppError(401, msg, "unauthorized");
export const forbidden = (msg = "Not permitted") => new AppError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new AppError(404, msg, "not_found");
export const conflict = (msg: string) => new AppError(409, msg, "conflict");
/**
 * Two promotions cannot cover the same dates. Its own code rather than a plain
 * conflict: the client translates codes, so a generic one would replace the
 * only useful part of this message — which dates are the problem — with "that
 * action is no longer possible".
 */
/**
 * The submitted declaration version is not the one now in force — typically a
 * browser left open across a deployment. Its own code so the client can say
 * "reload and read it again" rather than "that action is no longer possible":
 * recording agreement to wording the person never saw is the one outcome this
 * table exists to prevent.
 */
export const declarationOutdated = () =>
  new AppError(
    409,
    "The declaration has been updated since this page was opened",
    "declaration_outdated"
  );
export const promotionOverlap = () =>
  new AppError(
    409,
    "Another promotion already covers part of those dates",
    "promotion_overlap"
  );
export const tooManyRequests = (msg = "Rate limit exceeded") =>
  new AppError(429, msg, "rate_limited");
/** Out of credits for a metered action. (Pricing Plan §4) */
export const paymentRequired = (msg: string) =>
  new AppError(402, msg, "insufficient_credits");
export const featureDisabled = (msg = "Feature not available") =>
  new AppError(403, msg, "feature_disabled");
export const mfaRequired = () => new AppError(401, "MFA code required", "mfa_required");
export const passwordChangeRequired = () =>
  new AppError(
    403,
    "Set a new password before continuing",
    "password_change_required"
  );
export const mfaSetupRequired = () =>
  new AppError(403, "MFA setup is required for this account", "mfa_setup_required");
