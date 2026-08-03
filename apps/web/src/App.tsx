import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { DashboardPage } from "./pages/DashboardPage";
import { VerificationsPage } from "./pages/VerificationsPage";
import { AdminCompaniesPage } from "./pages/AdminCompaniesPage";
import { AdminVerificationsPage } from "./pages/AdminVerificationsPage";
import { AdminAuditPage } from "./pages/AdminAuditPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AccessSearchPage } from "./pages/AccessSearchPage";
import { AdminReportsPage } from "./pages/AdminReportsPage";
import { AdminAccessRequestsPage } from "./pages/AdminAccessRequestsPage";
import { AdminOversightPage } from "./pages/AdminOversightPage";
import { BuyCreditsPage } from "./pages/BuyCreditsPage";
import { AdminPaymentsPage } from "./pages/AdminPaymentsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { ReceiptsPage } from "./pages/ReceiptsPage";
import { AdminCompanyDetailPage } from "./pages/AdminCompanyDetailPage";
import { AdminStatsPage } from "./pages/AdminStatsPage";
import { AdminAccountsPage } from "./pages/AdminAccountsPage";
import { AdminPromotionsPage } from "./pages/AdminPromotionsPage";
import { AdminReportCategoriesPage } from "./pages/AdminReportCategoriesPage";
import { AdminOperationsPage } from "./pages/AdminOperationsPage";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { MfaSetupPage } from "./pages/MfaSetupPage";

const COMPANY = ["company_admin", "company_user"];
const REVIEWERS = ["super_admin", "admin_reviewer"];

function page(element: ReactNode, roles?: string[]) {
  return (
    <ProtectedRoute roles={roles}>
      <Layout>{element}</Layout>
    </ProtectedRoute>
  );
}

/**
 * A company page that only means anything once we have verified the company.
 * Until then the navigation omits it and this sends a typed URL back to the
 * dashboard, where the outstanding documents are.
 */
function verifiedPage(element: ReactNode) {
  return (
    <ProtectedRoute roles={COMPANY} requiresVerifiedCompany>
      <Layout>{element}</Layout>
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Public: the invitee has no account until they accept. */}
      <Route path="/invite/:token" element={<AcceptInvitePage />} />
      {/* Outside ProtectedRoute: a locked-out account has to be able to reach
          the one screen that unlocks it. */}
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/mfa-setup" element={<MfaSetupPage />} />


      {/* The dashboard is the one company page that works before verification:
          it is where the document checklist lives. Profile too — contact
          details are worth keeping current while the application is open. */}
      <Route path="/" element={page(<DashboardPage />)} />
      <Route path="/profile" element={page(<ProfilePage />, COMPANY)} />

      <Route path="/verifications" element={verifiedPage(<VerificationsPage />)} />
      <Route path="/billing" element={verifiedPage(<BuyCreditsPage />)} />
      <Route path="/team" element={<Navigate to="/" replace />} />
      <Route path="/receipts" element={verifiedPage(<ReceiptsPage />)} />

      {/* Tier B — pages themselves also degrade gracefully when the flag is off */}
      <Route path="/reports" element={verifiedPage(<ReportsPage />)} />
      <Route path="/report-access" element={verifiedPage(<AccessSearchPage />)} />
      <Route path="/admin/reports" element={page(<AdminReportsPage />, REVIEWERS)} />
      <Route path="/admin/oversight" element={page(<AdminOversightPage />, ["super_admin"])} />
      <Route path="/admin/access-requests" element={page(<AdminAccessRequestsPage />, REVIEWERS)} />

      <Route path="/admin/verifications" element={page(<AdminVerificationsPage />, REVIEWERS)} />
      <Route path="/admin/operations" element={page(<AdminOperationsPage />, REVIEWERS)} />
      <Route path="/admin/stats" element={page(<AdminStatsPage />, ["super_admin"])} />
      <Route path="/admin/accounts" element={page(<AdminAccountsPage />, ["super_admin"])} />
      <Route
        path="/admin/promotions"
        element={page(<AdminPromotionsPage />, ["super_admin"])}
      />
      <Route
        path="/admin/report-categories"
        element={page(<AdminReportCategoriesPage />, ["super_admin"])}
      />
      <Route path="/admin/companies" element={page(<AdminCompaniesPage />, ["super_admin"])} />
      <Route
        path="/admin/companies/:id"
        element={page(<AdminCompanyDetailPage />, ["super_admin"])}
      />
      <Route path="/admin/payments" element={page(<AdminPaymentsPage />, REVIEWERS)} />
      <Route path="/admin/audit" element={page(<AdminAuditPage />, ["super_admin"])} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
