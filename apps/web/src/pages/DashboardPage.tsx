import { useEffect, useState, type ReactNode } from "react";
import { alpha } from "@mui/material/styles";
import { Alert, Box, Button, Card, CardContent, Stack, Typography } from "@mui/material";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import PendingActionsIcon from "@mui/icons-material/PendingActions";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import DescriptionIcon from "@mui/icons-material/Description";
import BusinessIcon from "@mui/icons-material/Business";
import KeyIcon from "@mui/icons-material/VpnKey";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import { Link as RouterLink } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { useTierB } from "../hooks/useTierB";
import { useCompanyStatus } from "../hooks/useCompanyStatus";
import { CompanyDocuments } from "../components/CompanyDocuments";
import { CreditBalance } from "../components/CreditBalance";
import { PageHeader, StatusChip } from "../components/ui";
import { brand } from "../theme";

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

function BentoStat({
  label,
  value,
  icon,
  tone = brand.primary,
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <Card
      sx={{
        height: "100%",
        minHeight: 148,
        overflow: "hidden",
        background: `linear-gradient(145deg, ${alpha("#FFFFFF", 0.92)}, ${alpha(tone, 0.08)})`,
        backdropFilter: "blur(16px)",
        borderColor: alpha(tone, 0.16),
      }}
    >
      <CardContent sx={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", p: 2.25 }}>
        <Box
          sx={{
            width: 40,
            height: 40,
            display: "grid",
            placeItems: "center",
            borderRadius: 2.5,
            color: tone,
            bgcolor: alpha(tone, 0.12),
          }}
        >
          {icon}
        </Box>
        <Box sx={{ mt: 2 }}>
          <Typography variant="h4" lineHeight={1.1}>{value}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{label}</Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

function BentoHero({
  eyebrow,
  title,
  description,
  status,
  primaryAction,
  secondaryAction,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  status?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
}) {
  return (
    <Card
      sx={{
        height: "100%",
        minHeight: 224,
        color: "#fff",
        overflow: "hidden",
        position: "relative",
        background: `linear-gradient(135deg, ${brand.navy} 0%, ${brand.primaryDark} 58%, ${brand.teal} 145%)`,
        "&::before": {
          content: '""',
          position: "absolute",
          width: 260,
          height: 260,
          borderRadius: "50%",
          right: -96,
          top: -130,
          bgcolor: alpha("#FFFFFF", 0.11),
          filter: "blur(2px)",
        },
      }}
    >
      <CardContent sx={{ height: "100%", position: "relative", zIndex: 1, display: "flex", flexDirection: "column", p: { xs: 2.5, sm: 3 } }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
          <Typography variant="overline" sx={{ color: alpha("#fff", 0.68), fontWeight: 700, letterSpacing: "0.08em" }}>
            {eyebrow}
          </Typography>
          {status}
        </Stack>
        <Typography variant="h4" sx={{ mt: 1, maxWidth: 560 }}>{title}</Typography>
        <Typography variant="body2" sx={{ mt: 1, maxWidth: 620, color: alpha("#fff", 0.8) }}>{description}</Typography>
        {(primaryAction || secondaryAction) && (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} sx={{ mt: "auto", pt: 3 }}>
            {primaryAction}
            {secondaryAction}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const tierB = useTierB();
  const companyStatus = useCompanyStatus();
  const { t } = useTranslation();
  const [company, setCompany] = useState<Company | null>(null);
  const [stats, setStats] = useState<Record<string, number | "—">>({});

  const isCompany = user?.userType === "company";
  const isActiveCompany = isCompany && companyStatus.isVerified;
  const isReviewer = user?.role === "admin_reviewer" || user?.role === "super_admin";
  const isSuperAdmin = user?.role === "super_admin";

  useEffect(() => {
    if (isCompany && user?.companyId) {
      api<Company>(`/companies/${user.companyId}`).then(setCompany).catch(() => undefined);
    }
  }, [isCompany, user?.companyId]);

  useEffect(() => {
    void (async () => {
      const next: Record<string, number | "—"> = {};
      if (isActiveCompany) {
        try {
          const res = await api<{ items: { status: string }[] }>("/verifications");
          next.checks = res.items.length;
          next.checksPending = res.items.filter((item) => item.status === "pending").length;
          next.checksDone = res.items.filter((item) => item.status !== "pending").length;
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

  const grid = {
    display: "grid",
    gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))", lg: "repeat(4, minmax(0, 1fr))" },
    gap: 2,
  };

  return (
    <>
      <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />
      <Box sx={grid}>
        <Box sx={{ gridColumn: { xs: "auto", md: "span 2" } }}>
          {isCompany && company ? (
            <BentoHero
              eyebrow={t("nav.screening")}
              title={company.legalName}
              status={<StatusChip status={company.status} />}
              description={
                company.status === "verified"
                  ? tierB ? t("dashboard.verifiedWithTierB") : t("dashboard.verifiedOnly")
                  : company.status === "pending" ? t("dashboard.pendingOnboarding") : t("dashboard.suspended")
              }
              primaryAction={company.status === "verified" ? (
                <Button component={RouterLink} to="/verifications" variant="contained" color="inherit" endIcon={<ArrowForwardIcon />} sx={{ color: brand.navy, bgcolor: "#fff", "&:hover": { bgcolor: alpha("#fff", 0.9) } }}>
                  {t("dashboard.newCheck")}
                </Button>
              ) : undefined}
              secondaryAction={company.status === "verified" ? (
                <Button component={RouterLink} to="/billing" variant="outlined" sx={{ color: "#fff", borderColor: alpha("#fff", 0.45), "&:hover": { borderColor: "#fff", bgcolor: alpha("#fff", 0.08) } }}>
                  {t("nav.buyCredits")}
                </Button>
              ) : undefined}
            />
          ) : (
            <BentoHero
              eyebrow={t("nav.review")}
              title={t("dashboard.title")}
              description={t("dashboard.subtitle")}
              primaryAction={
                <Button component={RouterLink} to="/admin/operations" variant="contained" color="inherit" endIcon={<ArrowForwardIcon />} sx={{ color: brand.navy, bgcolor: "#fff", "&:hover": { bgcolor: alpha("#fff", 0.9) } }}>
                  {t("nav.operations")}
                </Button>
              }
            />
          )}
        </Box>

        {isActiveCompany && (
          <>
            <Box
              sx={{
                display: "grid",
                gridColumn: { xs: "auto", md: "span 2" },
                gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
                gridAutoRows: "minmax(148px, 1fr)",
                gap: 2,
              }}
            >
              <BentoStat label={t("dashboard.totalChecks")} value={stats.checks ?? "…"} icon={<FactCheckIcon />} />
              <BentoStat label={t("dashboard.awaitingResult")} value={stats.checksPending ?? "…"} icon={<PendingActionsIcon />} tone="#F59E0B" />
              <BentoStat label={t("dashboard.completed")} value={stats.checksDone ?? "…"} icon={<TaskAltIcon />} tone="#12A150" />
              {tierB && <BentoStat label={t("dashboard.conductReports")} value={stats.reports ?? "…"} icon={<DescriptionIcon />} tone="#9F1AB1" />}
            </Box>
            <Box sx={{ gridColumn: "1 / -1" }}><CreditBalance glass /></Box>
          </>
        )}

        {isReviewer && <BentoStat label={t("dashboard.checksToReview")} value={stats.queueChecks ?? "…"} icon={<FactCheckIcon />} tone="#F59E0B" />}
        {isReviewer && tierB && (
          <>
            <BentoStat label={t("dashboard.reportsToReview")} value={stats.queueReports ?? "…"} icon={<DescriptionIcon />} tone="#9F1AB1" />
            <BentoStat label={t("dashboard.accessRequestsStat")} value={stats.queueAccess ?? "…"} icon={<KeyIcon />} tone="#175CD3" />
          </>
        )}
        {isSuperAdmin && <BentoStat label={t("dashboard.companiesPending")} value={stats.pendingCompanies ?? "…"} icon={<BusinessIcon />} tone="#0FA48A" />}

        {isCompany && company?.status === "pending" && (
          <Box sx={{ gridColumn: "1 / -1" }}>
            <Card>
              <CardContent>
                <Stack spacing={2}>
                  <Alert severity="info"><Trans i18nKey="dashboard.pendingVerification" /></Alert>
                  <CompanyDocuments companyId={company.id} canUpload />
                </Stack>
              </CardContent>
            </Card>
          </Box>
        )}
        {!tierB && !(isCompany && !companyStatus.isVerified) && (
          <Box sx={{ gridColumn: "1 / -1" }}>
            <Alert severity="info" icon={false}>{t("dashboard.tierBDisabled")}</Alert>
          </Box>
        )}
      </Box>
    </>
  );
}
