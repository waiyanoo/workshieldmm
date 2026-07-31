import { useState, type FormEvent } from "react";
import { Alert, Button, Card, CardContent, Dialog, DialogContent, DialogTitle, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { EmptyState, PageHeader, StatusChip } from "../components/ui";
import { EMPTY_NRC, NrcInput, nrcToString, type NrcValue } from "../components/NrcInput";
import { apiErrorMessage } from "../i18n/apiError";

interface AccessItem { reportId: string; accessRequestId: string; status: string; }
interface GrantedReport { id: string; categoryName: string; narrativeSummary: string | null; submittedBy: string; createdAt: string; expiryDate: string | null; }

export function AccessSearchPage() {
  const { t } = useTranslation();
  const [nrc, setNrc] = useState<NrcValue>(EMPTY_NRC);
  const nationalId = nrcToString(nrc);
  const [items, setItems] = useState<AccessItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<GrantedReport | null>(null);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ items: AccessItem[] }>("/access-requests", { method: "POST", body: { subject: { nationalId } } });
      setItems(res.items);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally { setBusy(false); }
  }

  async function onView(reportId: string) {
    setError(null);
    try { setViewing(await api<GrantedReport>(`/reports/${reportId}`)); }
    catch (err) { setError(apiErrorMessage(err)); }
  }

  return <>
    <PageHeader title={t("access.title")} subtitle={t("access.subtitle", { cost: 1, view: 1 })} />
    {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
    <Card sx={{ mb: 3 }}><CardContent><form onSubmit={onSearch}><Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
      <NrcInput value={nrc} onChange={setNrc} required />
      <Button type="submit" variant="contained" startIcon={<SearchIcon />} disabled={busy} sx={{ alignSelf: { sm: "flex-start" }, whiteSpace: "nowrap" }}>{busy ? t("access.searching") : t("access.search")}</Button>
    </Stack></form></CardContent></Card>
    {items !== null && <Card><CardContent>{items.length === 0 ? <EmptyState title={t("access.noResults")} hint={t("access.noResultsHint")} /> : <Table size="small"><TableHead><TableRow><TableCell>{t("access.report")}</TableCell><TableCell>{t("access.accessStatus")}</TableCell><TableCell align="right">{t("common.actions")}</TableCell></TableRow></TableHead><TableBody>
      {items.map((i) => <TableRow key={i.accessRequestId} hover><TableCell sx={{ fontFamily: "monospace" }}>{i.reportId.slice(0, 8)}</TableCell><TableCell><StatusChip status={i.status} /></TableCell><TableCell align="right">{i.status === "approved" ? <Button size="small" variant="contained" onClick={() => onView(i.reportId)}>{t("access.readReport")}</Button> : <Typography variant="caption" color="text.secondary">{t("access.awaitingApproval")}</Typography>}</TableCell></TableRow>)}
    </TableBody></Table>}</CardContent></Card>}
    <Dialog open={viewing !== null} onClose={() => setViewing(null)} fullWidth maxWidth="sm"><DialogTitle>{t("access.conductReport")}: {viewing?.categoryName}</DialogTitle><DialogContent>{viewing && <Stack spacing={1.5} mt={0.5}>
      <Typography variant="body2"><b>{t("access.submittedBy")}</b> {viewing.submittedBy}</Typography>
      <Typography variant="body2"><b>{t("access.filed")}</b> {new Date(viewing.createdAt).toLocaleDateString()} · <b>{t("access.expires")}</b> {viewing.expiryDate ? new Date(viewing.expiryDate).toLocaleDateString() : "—"}</Typography>
      <Alert severity="info" icon={false}>{viewing.narrativeSummary ?? t("access.noSummary")}</Alert>
      <Typography variant="caption" color="text.secondary">{t("common.auditNote")}</Typography>
    </Stack>}</DialogContent></Dialog>
  </>;
}
