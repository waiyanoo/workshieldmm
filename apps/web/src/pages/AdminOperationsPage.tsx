import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, CardContent, Stack, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import AssignmentIcon from "@mui/icons-material/Assignment";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { BentoStatCard, GlassCard, PageHeader } from "../components/ui";
import { formatDateTime } from "../lib/date";

interface QueueSummary {
  key: "verifications" | "payments" | "reports";
  slaHours: number;
  open: number;
  overdue: number;
  oldestOpenedAt: string | null;
}

interface Summary {
  queues: QueueSummary[];
  overdueTotal: number;
}

const links: Record<QueueSummary["key"], string> = {
  verifications: "/admin/verifications?status=pending",
  payments: "/admin/payments",
  reports: "/admin/reports",
};

export function AdminOperationsPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await api<Summary>("/admin/operations"));
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  const totalOpen = useMemo(() => summary?.queues.reduce((total, queue) => total + queue.open, 0) ?? 0, [summary]);

  return (
    <Stack spacing={3}>
      <PageHeader title={t("operations.title")} subtitle={t("operations.subtitle")} action={<Button variant="outlined" onClick={() => void load()}>{t("operations.refresh")}</Button>} />
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      {summary?.overdueTotal ? <Alert severity="warning">{t("operations.overdueAlert", { count: summary.overdueTotal })}</Alert> : <Alert severity="success">{t("operations.onTarget")}</Alert>}
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: 2 }}>
        <BentoStatCard label={t("operations.openWork")} value={totalOpen} icon={<AssignmentIcon />} />
        <BentoStatCard label={t("operations.overdueWork")} value={summary?.overdueTotal ?? 0} icon={<AccessTimeIcon />} tone={summary?.overdueTotal ? "#B42318" : "#0E9384"} />
      </Box>
      <Stack spacing={2}>{summary?.queues.map((queue) => <GlassCard key={queue.key}><CardContent><Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}><Stack flex={1} spacing={0.5}><Typography variant="h6">{t(`operations.queues.${queue.key}`)}</Typography><Typography variant="body2" color="text.secondary">{t("operations.sla", { hours: queue.slaHours })}</Typography>{queue.oldestOpenedAt && <Typography variant="body2" color={queue.overdue ? "error.main" : "text.secondary"}>{t("operations.oldest", { date: formatDateTime(queue.oldestOpenedAt) })}</Typography>}</Stack><Stack direction="row" spacing={3} sx={{ minWidth: 150 }}><Box><Typography variant="caption" color="text.secondary">{t("operations.open")}</Typography><Typography variant="h6">{queue.open}</Typography></Box><Box><Typography variant="caption" color="text.secondary">{t("operations.overdue")}</Typography><Typography variant="h6" color={queue.overdue ? "error.main" : "text.primary"}>{queue.overdue}</Typography></Box></Stack><Button component={RouterLink} to={links[queue.key]} endIcon={<OpenInNewIcon />}>{t("operations.openQueue")}</Button></Stack></CardContent></GlassCard>)}</Stack>
    </Stack>
  );
}
