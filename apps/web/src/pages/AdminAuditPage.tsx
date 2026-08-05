import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Skeleton, Stack, TableBody, TableCell, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { PageHeader, ScrollableTable } from "../components/ui";

interface AuditEntry { id: number; actorId: string | null; actorName: string | null; actorType: string; action: string; resourceType: string; resourceId: string | null; metadata: Record<string, unknown>; ipAddress: string | null; timestamp: string; }
const PAGE = 50;
const actorColor: Record<string, "default" | "primary" | "secondary"> = { admin: "primary", user: "secondary", system: "default" };
const ACTION_PRESETS = ["", "auth.", "company.", "verification.", "payment.", "report.", "account.", "audit."];

export function AdminAuditPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState(() => searchParams.get("action") ?? "");
  const [resourceType, setResourceType] = useState(() => searchParams.get("resourceType") ?? "");
  const [resourceId, setResourceId] = useState(() => searchParams.get("resourceId") ?? "");
  const [actor, setActor] = useState(() => searchParams.get("actor") ?? "");
  const [from, setFrom] = useState(() => searchParams.get("from") ?? "");
  const [to, setTo] = useState(() => searchParams.get("to") ?? "");
  const [offset, setOffset] = useState(() => Math.max(Number(searchParams.get("offset")) || 0, 0));
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<AuditEntry | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(nextOffset = offset, filters = { action, resourceType, resourceId, actor, from, to }) {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
      if (filters.to) params.set("to", `${filters.to}T23:59:59.999`);
      const res = await api<{ items: AuditEntry[]; total: number }>(`/admin/audit-logs?${params}`);
      setItems(res.items); setTotal(res.total); setOffset(nextOffset);
      setSearchParams({ ...(filters.action ? { action: filters.action } : {}), ...(filters.resourceType ? { resourceType: filters.resourceType } : {}), ...(filters.resourceId ? { resourceId: filters.resourceId } : {}), ...(filters.actor ? { actor: filters.actor } : {}), ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}), offset: String(nextOffset) }, { replace: true });
    } catch (err) { setError(err instanceof ApiError ? err.message : t("admin.auditLoadError")); } finally { setLoading(false); }
  }
  useEffect(() => { void load(offset); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return <Stack spacing={3}>
    <PageHeader title={t("admin.auditTitle")} subtitle={t("admin.auditSubtitle")} />
    {error && <Alert severity="error">{error}</Alert>}
    <Card><CardContent>
      <Stack component="form" onSubmit={(e) => { e.preventDefault(); void load(0); }} spacing={2} mb={2}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField select label={t("admin.filterAction")} size="small" value={action} onChange={(e) => setAction(e.target.value)} fullWidth>
            {ACTION_PRESETS.map((value) => <MenuItem key={value || "all"} value={value}>{value || t("admin.allActions")}</MenuItem>)}
          </TextField>
          <TextField label={t("admin.filterResource")} size="small" value={resourceType} onChange={(e) => setResourceType(e.target.value)} placeholder={t("admin.resourceTypePlaceholder")} fullWidth />
          <TextField label={t("admin.filterResourceId")} size="small" value={resourceId} onChange={(e) => setResourceId(e.target.value)} placeholder={t("admin.resourceIdPlaceholder")} fullWidth />
          <TextField label={t("admin.filterActor")} size="small" value={actor} onChange={(e) => setActor(e.target.value)} placeholder={t("admin.actorPlaceholder")} fullWidth />
        </Stack>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
          <TextField label={t("admin.fromDate")} type="date" size="small" value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
          <TextField label={t("admin.toDate")} type="date" size="small" value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
          <Button type="submit" variant="contained" sx={{ minWidth: 120 }}>{t("admin.apply")}</Button>
          {(action || resourceType || resourceId || actor || from || to) && <Button onClick={() => { const empty = { action: "", resourceType: "", resourceId: "", actor: "", from: "", to: "" }; setAction(""); setResourceType(""); setResourceId(""); setActor(""); setFrom(""); setTo(""); void load(0, empty); }}>{t("common.clearFilters")}</Button>}
        </Stack>
      </Stack>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={1}>{Object.entries({ action, resourceType, resourceId, actor, from, to }).filter(([, value]) => value).map(([key, value]) => <Chip key={key} size="small" label={`${t(`admin.auditFilterNames.${key}`, { defaultValue: key })}: ${value}`} />)}</Stack>
      <Typography variant="body2" color="text.secondary" mb={1}>{t("common.resultCount", { count: total })}{(action || resourceType || resourceId || actor || from || to) && ` · ${t("common.filtered")}`}</Typography>
      {loading ? <Stack spacing={1}>{[1, 2, 3].map((key) => <Skeleton key={key} height={54} />)}</Stack> : items.length === 0 ? <Typography variant="body2" color="text.secondary">{t("admin.noEntries")}</Typography> : <>
        <Box sx={{ display: { xs: "none", md: "block" } }}><ScrollableTable minWidth={900}><TableHead><TableRow><TableCell>#</TableCell><TableCell>{t("admin.time")}</TableCell><TableCell>{t("admin.actor")}</TableCell><TableCell>{t("admin.action")}</TableCell><TableCell>{t("admin.resource")}</TableCell><TableCell>{t("admin.metadata")}</TableCell><TableCell>{t("admin.ipAddress")}</TableCell></TableRow></TableHead>
          <TableBody>{items.map((entry) => { const actorLabel = entry.actorName ?? t(`admin.actorTypes.${entry.actorType}`, { defaultValue: entry.actorType }); const actionLabel = t(`admin.auditActions.${entry.action}`, { defaultValue: entry.action.replace(/[._]/g, " ") }); return <TableRow key={entry.id}><TableCell sx={{ color: "text.secondary" }}>{entry.id}</TableCell><TableCell>{new Date(entry.timestamp).toLocaleString()}</TableCell><TableCell><Tooltip title={entry.actorId ?? "—"}><Chip size="small" label={actorLabel} color={actorColor[entry.actorType] ?? "default"} /></Tooltip></TableCell><TableCell><Typography variant="body2" fontWeight={600}>{t("admin.auditDescription", { actor: actorLabel, action: actionLabel, resource: entry.resourceType.replace(/_/g, " ") })}</Typography><Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>{entry.action}</Typography></TableCell><TableCell sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{entry.resourceType}{entry.resourceId ? `:${entry.resourceId.slice(0, 8)}` : ""}</TableCell><TableCell><Button size="small" onClick={() => setDetails(entry)}>{t("admin.viewDetails")}</Button></TableCell><TableCell>{entry.ipAddress ?? "—"}</TableCell></TableRow>; })}</TableBody>
        </ScrollableTable></Box>
        <Stack sx={{ display: { xs: "flex", md: "none" } }} spacing={1.5}>{items.map((entry) => { const actorLabel = entry.actorName ?? t(`admin.actorTypes.${entry.actorType}`, { defaultValue: entry.actorType }); const actionLabel = t(`admin.auditActions.${entry.action}`, { defaultValue: entry.action.replace(/[._]/g, " ") }); return <Card key={entry.id} variant="outlined"><CardContent><Stack spacing={1}><Stack direction="row" justifyContent="space-between"><Chip size="small" label={actorLabel} color={actorColor[entry.actorType] ?? "default"} /><Typography variant="caption">{new Date(entry.timestamp).toLocaleString()}</Typography></Stack><Typography variant="body2" fontWeight={600}>{t("admin.auditDescription", { actor: actorLabel, action: actionLabel, resource: entry.resourceType.replace(/_/g, " ") })}</Typography><Typography variant="caption" sx={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>{entry.resourceType}{entry.resourceId ? `:${entry.resourceId}` : ""}</Typography><Button variant="outlined" onClick={() => setDetails(entry)}>{t("admin.viewDetails")}</Button></Stack></CardContent></Card>; })}</Stack>
      </>}
      <TablePagination component="div" count={total} page={Math.floor(offset / PAGE)} rowsPerPage={PAGE} rowsPerPageOptions={[PAGE]} onPageChange={(_e, page) => void load(page * PAGE)} labelRowsPerPage={t("admin.rowsPerPage")} />
    </CardContent></Card>
    <Dialog open={details !== null} onClose={() => setDetails(null)} fullWidth maxWidth="sm"><DialogTitle>{t("admin.auditDetailsTitle", { id: details?.id })}</DialogTitle><DialogContent dividers><Stack spacing={2}><Typography variant="body2"><b>{t("admin.action")}:</b> {details?.action}</Typography><Typography variant="body2"><b>{t("admin.resource")}:</b> {details?.resourceType}{details?.resourceId ? `:${details.resourceId}` : ""}</Typography><Typography component="pre" variant="caption" sx={{ m: 0, p: 2, bgcolor: "grey.100", borderRadius: 1, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{details ? JSON.stringify(details.metadata, null, 2) : ""}</Typography></Stack></DialogContent><DialogActions><Button onClick={() => setDetails(null)}>{t("common.close")}</Button></DialogActions></Dialog>
  </Stack>;
}
