import type { Role } from "@hyper/shared";

/** The authenticated principal attached to a request by requireAuth. */
export interface AuthUser {
  id: string;
  userType: "company" | "platform";
  role: Role;
  companyId?: string;
  /** On an admin-issued temporary password; every route but change-password is closed. */
  mustChangePassword?: boolean;
  /** Role requires MFA and none is enrolled; only the setup routes are open. */
  mfaSetupRequired?: boolean;
}
