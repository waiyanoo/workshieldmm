import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import { Box, CircularProgress } from "@mui/material";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const VerificationsPage = lazy(() => import("./pages/VerificationsPage").then((m) => ({ default: m.VerificationsPage })));
const AdminCompaniesPage = lazy(() => import("./pages/AdminCompaniesPage").then((m) => ({ default: m.AdminCompaniesPage })));
const AdminVerificationsPage = lazy(() => import("./pages/AdminVerificationsPage").then((m) => ({ default: m.AdminVerificationsPage })));
const AdminAuditPage = lazy(() => import("./pages/AdminAuditPage").then((m) => ({ default: m.AdminAuditPage })));
const ReportsPage = lazy(() => import("./pages/ReportsPage").then((m) => ({ default: m.ReportsPage })));
const AccessSearchPage = lazy(() => import("./pages/AccessSearchPage").then((m) => ({ default: m.AccessSearchPage })));
const AdminReportsPage = lazy(() => import("./pages/AdminReportsPage").then((m) => ({ default: m.AdminReportsPage })));
const AdminAccessRequestsPage = lazy(() => import("./pages/AdminAccessRequestsPage").then((m) => ({ default: m.AdminAccessRequestsPage })));
const AdminOversightPage = lazy(() => import("./pages/AdminOversightPage").then((m) => ({ default: m.AdminOversightPage })));
const BuyCreditsPage = lazy(() => import("./pages/BuyCreditsPage").then((m) => ({ default: m.BuyCreditsPage })));
const AdminPaymentsPage = lazy(() => import("./pages/AdminPaymentsPage").then((m) => ({ default: m.AdminPaymentsPage })));
const ProfilePage = lazy(() => import("./pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
const AcceptInvitePage = lazy(() => import("./pages/AcceptInvitePage").then((m) => ({ default: m.AcceptInvitePage })));
const ReceiptsPage = lazy(() => import("./pages/ReceiptsPage").then((m) => ({ default: m.ReceiptsPage })));
const AdminCompanyDetailPage = lazy(() => import("./pages/AdminCompanyDetailPage").then((m) => ({ default: m.AdminCompanyDetailPage })));
const AdminStatsPage = lazy(() => import("./pages/AdminStatsPage").then((m) => ({ default: m.AdminStatsPage })));
const AdminAccountsPage = lazy(() => import("./pages/AdminAccountsPage").then((m) => ({ default: m.AdminAccountsPage })));
const AdminPromotionsPage = lazy(() => import("./pages/AdminPromotionsPage").then((m) => ({ default: m.AdminPromotionsPage })));
const AdminReportCategoriesPage = lazy(() => import("./pages/AdminReportCategoriesPage").then((m) => ({ default: m.AdminReportCategoriesPage })));
const AdminOperationsPage = lazy(() => import("./pages/AdminOperationsPage").then((m) => ({ default: m.AdminOperationsPage })));
const AdminSettingsPage = lazy(() => import("./pages/AdminSettingsPage").then((m) => ({ default: m.AdminSettingsPage })));
const ChangePasswordPage = lazy(() => import("./pages/ChangePasswordPage").then((m) => ({ default: m.ChangePasswordPage })));
const MfaSetupPage = lazy(() => import("./pages/MfaSetupPage").then((m) => ({ default: m.MfaSetupPage })));

const COMPANY = ["company_admin", "company_user"];
const REVIEWERS = ["super_admin", "admin_reviewer"];

function RouteLoading() {
  return (
    <Box sx={{ minHeight: 240, display: "grid", placeItems: "center" }} role="status">
      <CircularProgress size={30} />
    </Box>
  );
}

function page(element: ReactNode, roles?: string[]) {
  return (
    <ProtectedRoute roles={roles}>
      <Layout><Suspense fallback={<RouteLoading />}>{element}</Suspense></Layout>
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
      <Layout><Suspense fallback={<RouteLoading />}>{element}</Suspense></Layout>
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Public: the invitee has no account until they accept. */}
      <Route path="/invite/:token" element={<Suspense fallback={<RouteLoading />}><AcceptInvitePage /></Suspense>} />
      {/* Outside ProtectedRoute: a locked-out account has to be able to reach
          the one screen that unlocks it. */}
      <Route path="/change-password" element={<Suspense fallback={<RouteLoading />}><ChangePasswordPage /></Suspense>} />
      <Route path="/mfa-setup" element={<Suspense fallback={<RouteLoading />}><MfaSetupPage /></Suspense>} />


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
      <Route path="/admin/settings" element={page(<AdminSettingsPage />, ["super_admin"])} />
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
