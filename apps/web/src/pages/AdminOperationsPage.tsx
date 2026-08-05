import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, CardContent, Chip, Divider, Stack, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import AssignmentIcon from "@mui/icons-material/Assignment";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import { useTranslation } from "react-i18next";
import { Link as RouterLink } from "react-router-dom";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { BentoStatCard, GlassCard, PageHeader } from "../components/ui";
import { formatDateTime } from "../lib/date";
import { useTierB } from "../hooks/useTierB";
import { useAuth } from "../auth/AuthContext";

interface QueueSummary { key: "verifications" | "payments" | "companies" | "reports"; slaHours: number; open: number; overdue: number; oldestOpenedAt: string | null; }
interface WorkItem { kind: "verification" | "payment" | "company" | "report"; id: string; title: string; subtitle: string; reference: string | null; openedAt: string; slaHours: number; assignedTo: string | null; assignedName: string | null; }
interface Summary { queues: QueueSummary[]; overdueTotal: number; workItems: WorkItem[]; }
const links: Record<QueueSummary["key"], string> = { verifications: "/admin/verifications?status=pending", payments: "/admin/payments", companies: "/admin/companies?status=pending", reports: "/admin/reports" };
function workLink(item: WorkItem): string {
  if (item.kind === "company") return `/admin/companies/${item.id}?from=operations`;
  if (item.kind === "payment") return `/admin/payments?status=submitted&q=${encodeURIComponent(item.reference ?? "")}`;
  if (item.kind === "verification") return `/admin/verifications?status=pending&q=${encodeURIComponent(item.title)}`;
  return "/admin/reports";
}

export function AdminOperationsPage() {
  const { t } = useTranslation();
  const tierB = useTierB();
  const { user } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { setSummary(await api<Summary>("/admin/operations")); setError(null); } catch (err) { setError(apiErrorMessage(err)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const queues = useMemo(() => summary?.queues.filter((queue) => tierB || queue.key !== "reports") ?? [], [summary, tierB]);
  const totalOpen = useMemo(() => queues.reduce((total, queue) => total + queue.open, 0), [queues]);
  const overdueTotal = useMemo(() => queues.reduce((total, queue) => total + queue.overdue, 0), [queues]);
  const claim = useCallback(async (item: WorkItem) => {
    try {
      await api(`/admin/verifications/${item.id}/assign`, { method: "POST", body: { to: item.assignedTo === user?.id ? null : user?.id } });
      await load();
    } catch (err) { setError(apiErrorMessage(err)); }
  }, [load, user?.id]);

  return <Stack spacing={3}>
    <PageHeader title={t("operations.title")} subtitle={t("operations.subtitle")} action={<Button variant="outlined" onClick={() => void load()}>{t("operations.refresh")}</Button>} />
    {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
    {overdueTotal ? <Alert severity="warning">{t("operations.overdueAlert", { count: overdueTotal })}</Alert> : <Alert severity="success">{t("operations.onTarget")}</Alert>}
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: 2 }}>
      <BentoStatCard label={t("operations.openWork")} value={totalOpen} icon={<AssignmentIcon />} />
      <BentoStatCard label={t("operations.overdueWork")} value={overdueTotal} icon={<AccessTimeIcon />} tone={overdueTotal ? "#B42318" : "#0E9384"} />
    </Box>
    <GlassCard><CardContent>
      <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" spacing={1} mb={2}>
        <Box><Typography variant="h6">{t("operations.inboxTitle")}</Typography><Typography variant="body2" color="text.secondary">{t("operations.inboxSubtitle")}</Typography></Box>
        {summary?.workItems[0] && <Button variant="contained" component={RouterLink} to={workLink(summary.workItems[0])}>{t("operations.reviewNext")}</Button>}
      </Stack>
      {summary?.workItems.length ? <Stack divider={<Divider flexItem />}>
        {summary.workItems.map((item) => { const overdue = Date.now() - new Date(item.openedAt).getTime() > item.slaHours * 3_600_000; return <Stack key={`${item.kind}-${item.id}`} direction={{ xs: "column", sm: "row" }} spacing={1.5} alignItems={{ sm: "center" }} py={1.5}>
          <Chip size="small" label={t(`operations.kinds.${item.kind}`)} color={overdue ? "error" : "default"} sx={{ alignSelf: { xs: "flex-start", sm: "center" } }} />
          <Box flex={1} minWidth={0}><Typography fontWeight={600} noWrap>{item.title}</Typography><Typography variant="body2" color="text.secondary" noWrap>{item.subtitle}{item.reference ? ` · ${item.reference}` : ""}</Typography></Box>
          <Typography variant="caption" color={overdue ? "error.main" : "text.secondary"}>{overdue ? t("operations.overdue") : t("operations.opened", { date: formatDateTime(item.openedAt) })}</Typography>
          {item.kind === "verification" && <Button size="small" variant="outlined" disabled={Boolean(item.assignedTo && item.assignedTo !== user?.id)} onClick={() => void claim(item)}>{item.assignedTo === user?.id ? t("queue.release") : item.assignedName ? t("operations.assignedTo", { name: item.assignedName }) : t("queue.claim")}</Button>}
          <Button size="small" component={RouterLink} to={workLink(item)}>{t("admin.review")}</Button>
        </Stack>; })}
      </Stack> : <Typography variant="body2" color="text.secondary">{t("operations.inboxEmpty")}</Typography>}
    </CardContent></GlassCard>
    <Stack spacing={2}>{queues.map((queue) => <GlassCard key={queue.key}><CardContent>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ md: "center" }}>
        <Stack flex={1} spacing={0.5}><Typography variant="h6">{t(`operations.queues.${queue.key}`)}</Typography><Typography variant="body2" color="text.secondary">{t("operations.sla", { hours: queue.slaHours })}</Typography>{queue.oldestOpenedAt && <Typography variant="body2" color={queue.overdue ? "error.main" : "text.secondary"}>{t("operations.oldest", { date: formatDateTime(queue.oldestOpenedAt) })}</Typography>}</Stack>
        <Stack direction="row" spacing={3} sx={{ minWidth: 150 }}><Box><Typography variant="caption" color="text.secondary">{t("operations.open")}</Typography><Typography variant="h6">{queue.open}</Typography></Box><Box><Typography variant="caption" color="text.secondary">{t("operations.overdue")}</Typography><Typography variant="h6" color={queue.overdue ? "error.main" : "text.primary"}>{queue.overdue}</Typography></Box></Stack>
        <Button component={RouterLink} to={links[queue.key]} endIcon={<OpenInNewIcon />}>{t("operations.openQueue")}</Button>
      </Stack>
    </CardContent></GlassCard>)}</Stack>
  </Stack>;
}
