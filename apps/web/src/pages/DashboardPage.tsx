import { useEffect, useState } from "react";
import { Alert, Button, Card, CardContent, Stack, Typography } from "@mui/material";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import PendingActionsIcon from "@mui/icons-material/PendingActions";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import DescriptionIcon from "@mui/icons-material/Description";
import BusinessIcon from "@mui/icons-material/Business";
import KeyIcon from "@mui/icons-material/VpnKey";
import { Link as RouterLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { useTierB } from "../hooks/useTierB";
import { useCompanyStatus } from "../hooks/useCompanyStatus";
import { Trans, useTranslation } from "react-i18next";
import { CompanyDocuments } from "../components/CompanyDocuments";
import { CreditBalance } from "../components/CreditBalance";
import { PageHeader, StatCard, StatusChip } from "../components/ui";

interface Company {
  id: string;
  legalName: string;
  status: string;
}

async function count(path: string, filter?: (item: never) => boolean): Promise<number | "—"> {
  try {
    const res = await api<{ items: unknown[] }>(path);
    const items = filter ? (res.items as never[]).filter(filter) : res.items;
    return items.length;
  } catch {
    return "—";
  }
}

export function DashboardPage() {
  const { user } = useAuth();
  const tierB = useTierB();
  const companyStatus = useCompanyStatus();
  const { t } = useTranslation();
  const [company, setCompany] = useState<Company | null>(null);
  const [stats, setStats] = useState<Record<string, number | "—">>({});

  const isCompany = user?.userType === "company";
  // A company we have not verified has no checks, no reports and no credits.
  // Showing three zeroed stat cards and an empty balance dresses up "your
  // application is still open" as an empty product.
  const isActiveCompany = isCompany && companyStatus.isVerified;
  const isReviewer = user?.role === "admin_reviewer" || user?.role === "super_admin";
  const isSuperAdmin = user?.role === "super_admin";

  useEffect(() => {
    if (isCompany && user?.companyId) {
      api<Company>(`/companies/${user.companyId}`)
        .then(setCompany)
        .catch(() => undefined);
    }
  }, [isCompany, user?.companyId]);

  useEffect(() => {
    (async () => {
      const next: Record<string, number | "—"> = {};
      if (isActiveCompany) {
        try {
          const res = await api<{ items: { status: string }[] }>("/verifications");
          next.checks = res.items.length;
          next.checksPending = res.items.filter((i) => i.status === "pending").length;
          next.checksDone = res.items.filter((i) => i.status !== "pending").length;
        } catch {
          next.checks = next.checksPending = next.checksDone = "—";
        }
        if (tierB) next.reports = await count("/reports");
      }
      if (isReviewer) {
        next.queueChecks = await count("/admin/verifications?status=pending");
        if (tierB) {
          next.queueReports = await count("/admin/reports/pending");
          next.queueAccess = await count("/admin/access-requests");
        }
      }
      if (isSuperAdmin) next.pendingCompanies = await count("/companies?status=pending");
      setStats(next);
    })();
  }, [isActiveCompany, isReviewer, isSuperAdmin, tierB]);

  if (!user) return null;

  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        subtitle={t("dashboard.subtitle")}
      />

      {/* Stat cards */}
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} flexWrap="wrap" useFlexGap mb={3}>
        {isActiveCompany && (
          <>
            <StatCard label={t("dashboard.totalChecks")} value={stats.checks ?? "…"} icon={<FactCheckIcon />} />
            <StatCard
              label={t("dashboard.awaitingResult")}
              value={stats.checksPending ?? "…"}
              icon={<PendingActionsIcon />}
              tone="#F59E0B"
            />
            <StatCard
              label={t("dashboard.completed")}
              value={stats.checksDone ?? "…"}
              icon={<TaskAltIcon />}
              tone="#12A150"
            />
            {tierB && (
              <StatCard
                label={t("dashboard.conductReports")}
                value={stats.reports ?? "…"}
                icon={<DescriptionIcon />}
                tone="#9F1AB1"
              />
            )}
          </>
        )}
        {isReviewer && (
          <StatCard
            label={t("dashboard.checksToReview")}
            value={stats.queueChecks ?? "…"}
            icon={<FactCheckIcon />}
            tone="#F59E0B"
          />
        )}
        {isReviewer && tierB && (
          <>
            <StatCard
              label={t("dashboard.reportsToReview")}
              value={stats.queueReports ?? "…"}
              icon={<DescriptionIcon />}
              tone="#9F1AB1"
            />
            <StatCard
              label={t("dashboard.accessRequestsStat")}
              value={stats.queueAccess ?? "…"}
              icon={<KeyIcon />}
              tone="#175CD3"
            />
          </>
        )}
        {isSuperAdmin && (
          <StatCard
            label={t("dashboard.companiesPending")}
            value={stats.pendingCompanies ?? "…"}
            icon={<BusinessIcon />}
            tone="#0FA48A"
          />
        )}
      </Stack>

      {/* Company status / onboarding */}
      {isCompany && company && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1.5}>
              <Typography variant="subtitle1">{company.legalName}</Typography>
              <StatusChip status={company.status} />
            </Stack>

            {company.status === "pending" ? (
              <Stack spacing={2}>
                <Alert severity="info">
                  <Trans i18nKey="dashboard.pendingVerification" />
                </Alert>
                {/* Says plainly what is and is not available yet, so the pared
                    back navigation reads as a stage in the process rather than
                    as something missing. */}
                <Typography variant="body2" color="text.secondary">
                  {t("dashboard.pendingOnboarding")}
                </Typography>
                <CompanyDocuments companyId={company.id} canUpload />
              </Stack>
            ) : company.status === "verified" ? (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
                <Typography variant="body2" color="text.secondary" flex={1}>
                  {tierB ? t("dashboard.verifiedWithTierB") : t("dashboard.verifiedOnly")}
                </Typography>
                <Button variant="contained" component={RouterLink} to="/verifications">
                  {t("dashboard.newCheck")}
                </Button>
              </Stack>
            ) : (
              <Alert severity="error">{t("dashboard.suspended")}</Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Credits — metered actions are billed against this balance. Welcome
          credits are granted on verification, so before that there is nothing
          here to show and no action they could be spent on. */}
      {isActiveCompany && (
        <Stack sx={{ mb: 3 }}>
          <CreditBalance />
        </Stack>
      )}

      {/* Not shown to a company still waiting on verification: which tiers are
          switched on is not their problem yet. Platform staff still see it. */}
      {!tierB && !(isCompany && !companyStatus.isVerified) && (
        <Typography variant="body2" color="text.secondary">
          {t("dashboard.tierBDisabled")}
        </Typography>
      )}
    </>
  );
}
