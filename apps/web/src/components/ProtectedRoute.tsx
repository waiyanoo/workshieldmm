import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useCompanyStatus } from "../hooks/useCompanyStatus";

export function ProtectedRoute({
  children,
  roles,
  requiresVerifiedCompany = false,
}: {
  children: ReactNode;
  roles?: string[];
  /**
   * Pages that are useless to a company we have not verified yet. Reached by
   * typing the URL or following an old bookmark — the navigation already omits
   * them — so this sends them back to the dashboard, where the onboarding
   * checklist actually is, instead of rendering a screen where every button
   * fails.
   */
  requiresVerifiedCompany?: boolean;
}) {
  const { user } = useAuth();
  const company = useCompanyStatus();

  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;

  if (requiresVerifiedCompany && user.userType === "company") {
    // Wait for the answer rather than bouncing a verified user off their own
    // page on a slow first paint.
    if (!company.loaded) return null;
    if (!company.isVerified) return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
