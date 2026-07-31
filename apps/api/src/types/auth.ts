import type { Role } from "@hyper/shared";

/** The authenticated principal attached to a request by requireAuth. */
export interface AuthUser {
  id: string;
  userType: "company" | "platform";
  role: Role;
  companyId?: string;
}
