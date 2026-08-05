/**
 * Payment reconciliation. (Pricing Plan §7)
 *
 * The reviewer matches each claim against the KBZPay / WavePay / bank statement
 * and confirms or rejects. Confirming is what grants the credits, so the screen
 * puts the two things they must match — our reference code and the payer's
 * transaction number — front and centre, and says outright that a screenshot is
 * not proof on its own.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Skeleton,
  Stack,
  Tab,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TablePagination,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import ImageIcon from "@mui/icons-material/Image";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { EmptyState, PageHeader, ScrollableTable, StatusChip } from "../components/ui";

interface PaymentItem {
  id: string;
  referenceCode: string;
  credits: number;
  amountMmk: number;
  provider: string;
  status: string;
  kind: string;
  plan: string | null;
  billingCycle: string | null;
  payerReference: string | null;
  payerNote: string | null;
  hasProof: boolean;
  companyName: string;
  submittedAt: string | null;
  createdAt: string;
}

const mmk = (n: number) => `${n.toLocaleString("en-US")} MMK`;

export function AdminPaymentsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "submitted");
  const [items, setItems] = useState<PaymentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<PaymentItem | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(() => Math.max(Number(searchParams.get("page")) || 0, 0));
  const [rowsPerPage, setRowsPerPage] = useState(() => [10, 25, 50].includes(Number(searchParams.get("limit"))) ? Number(searchParams.get("limit")) : 25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(next = status, nextPage = page, nextRows = rowsPerPage, nextQ = q) {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ status: next, q: nextQ.trim(), limit: String(nextRows), offset: String(nextPage * nextRows) });
      const res = await api<{ items: PaymentItem[]; total: number }>(`/admin/payments?${params}`);
      setItems(res.items);
      setTotal(res.total);
      setStatus(next);
      setPage(nextPage);
      setSearchParams({ status: next, ...(nextQ.trim() ? { q: nextQ.trim() } : {}), page: String(nextPage), limit: String(nextRows) }, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("admin.paymentsLoadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(status, page, rowsPerPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function viewProof(id: string) {
    try {
      const { url } = await api<{ url: string }>(`/admin/payments/${id}/proof`);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("admin.proofOpenError"));
    }
  }

  async function decide(decision: "confirm" | "reject") {
    if (!deciding) return;
    const nextItem = items.find((item) => item.id !== deciding.id && item.status === "submitted");
    if (!note.trim()) {
      setError(t("admin.paymentNoteRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/payments/${deciding.id}/decision`, {
        method: "POST",
        body: { decision, note },
      });
      setNote("");
      setNotice(t(decision === "confirm" ? "admin.paymentConfirmedNotice" : "admin.paymentRejectedNotice"));
      await load();
      setDeciding(nextItem ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("admin.decisionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("admin.paymentsTitle")}
        subtitle={t("admin.paymentsSubtitle")}
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }}>{notice}</Alert>}

      <Tabs value={status} onChange={(_e, v: string) => void load(v, 0)} sx={{ mb: 2 }} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile>
        <Tab label={t("admin.awaitingConfirmation")} value="submitted" />
        <Tab label={t("admin.confirmedTab")} value="confirmed" />
        <Tab label={t("admin.rejectedTab")} value="rejected" />
        <Tab label={t("admin.unpaidTab")} value="awaiting_payment" />
      </Tabs>

      <Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={1} mb={2} onSubmit={(e) => { e.preventDefault(); void load(status, 0); }}>
        <TextField size="small" fullWidth label={t("admin.searchPayments")} placeholder={t("admin.searchPaymentsPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="contained">{t("common.search")}</Button>
        {q && <Button onClick={() => { setQ(""); void load(status, 0, rowsPerPage, ""); }}>{t("common.clearFilters")}</Button>}
      </Stack>

      <Typography variant="body2" color="text.secondary" mb={1}>{t("common.resultCount", { count: total })}{q && ` · ${t("common.filtered")}`}</Typography>
      {q && <Chip size="small" label={`${t("common.search")}: ${q}`} onDelete={() => { setQ(""); void load(status, 0, rowsPerPage, ""); }} sx={{ mb: 1 }} />}

      <Card>
        <CardContent>
          {loading ? <Stack spacing={1}>{[1, 2, 3].map((key) => <Skeleton key={key} height={54} />)}</Stack> : items.length === 0 ? (
            <EmptyState title={t("admin.nothingHere")} />
          ) : (
            <Box sx={{ display: { xs: "none", md: "block" } }}><ScrollableTable minWidth={940}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.ourReference")}</TableCell>
                  <TableCell>{t("admin.company")}</TableCell>
                  <TableCell>{t("admin.amount")}</TableCell>
                  <TableCell>{t("admin.forWhat")}</TableCell>
                  <TableCell>{t("admin.method")}</TableCell>
                  <TableCell>{t("admin.theirTxnNo")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.id} hover>
                    <TableCell sx={{ fontFamily: "monospace" }}>{p.referenceCode}</TableCell>
                    <TableCell>{p.companyName}</TableCell>
                    <TableCell>{mmk(p.amountMmk)}</TableCell>
                    <TableCell>
                      {p.kind === "subscription"
                        ? t("admin.planPurchase", { plan: p.plan, cycle: p.billingCycle })
                        : t("admin.creditPurchase", { count: p.credits })}
                    </TableCell>
                    <TableCell>{p.provider}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {p.payerReference ?? "—"}
                    </TableCell>
                    <TableCell align="right">
                      {p.status === "submitted" ? (
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => {
                            setDeciding(p);
                            setNote("");
                          }}
                        >
                            {t("admin.reviewPayment")}
                        </Button>
                      ) : (
                        <StatusChip status={p.status} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable></Box>
          )}
          {!loading && items.length > 0 && <Stack sx={{ display: { xs: "flex", md: "none" } }} spacing={1.5}>{items.map((p) => <Card key={p.id} variant="outlined"><CardContent><Stack spacing={1}><Stack direction="row" justifyContent="space-between" spacing={1}><Typography fontWeight={700}>{p.companyName}</Typography><StatusChip status={p.status} /></Stack><Typography variant="caption" sx={{ fontFamily: "monospace" }}>{p.referenceCode}</Typography><Typography variant="body2">{mmk(p.amountMmk)} · {p.provider}</Typography><Typography variant="body2" color="text.secondary">{t("admin.theirTxnNo")}: {p.payerReference ?? "—"}</Typography>{p.status === "submitted" && <Button variant="contained" fullWidth onClick={() => { setDeciding(p); setNote(""); }}>{t("admin.reviewPayment")}</Button>}</Stack></CardContent></Card>)}</Stack>}
          <TablePagination component="div" count={total} page={page} rowsPerPage={rowsPerPage} onPageChange={(_e, value) => void load(status, value)} onRowsPerPageChange={(e) => { const value = Number(e.target.value); setRowsPerPage(value); void load(status, 0, value); }} rowsPerPageOptions={[10, 25, 50]} labelRowsPerPage={t("admin.rowsPerPage")} />
        </CardContent>
      </Card>

      <Dialog open={deciding !== null} onClose={() => setDeciding(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {t("admin.reviewPayment")} {deciding?.referenceCode}
          <Typography variant="body2" color="text.secondary">
            {deciding?.companyName} · {deciding && mmk(deciding.amountMmk)} for{" "}
            {deciding?.kind === "subscription"
              ? t("admin.planPurchase", { plan: deciding.plan, cycle: deciding.billingCycle })
              : t("admin.creditPurchase", { count: deciding?.credits })}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          {deciding && (
            <Stack spacing={2}>
              <Alert severity="warning" icon={false}>
                <Typography variant="caption" fontWeight={700} display="block">
                  {t("admin.checkStatement")}
                </Typography>
                <Typography variant="body2">
                  {t("admin.checkStatementBody", { provider: deciding.provider })}
                </Typography>
              </Alert>

              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>
                  {t("admin.matchThese").toUpperCase()}
                </Typography>
                <Typography variant="body2">
                  {t("admin.transferNoteShould")}{" "}
                  <b style={{ fontFamily: "monospace" }}>{deciding.referenceCode}</b>
                </Typography>
                <Typography variant="body2">
                  {t("admin.theirTransactionNumber")}{" "}
                  <b style={{ fontFamily: "monospace" }}>{deciding.payerReference}</b>
                </Typography>
                <Typography variant="body2">
                  {t("admin.amount")}: <b>{mmk(deciding.amountMmk)}</b>
                </Typography>
                {deciding.submittedAt && (
                  <Typography variant="body2" color="text.secondary">
                    {t("admin.declaredAt", { date: new Date(deciding.submittedAt).toLocaleString() })}
                  </Typography>
                )}
              </Stack>

              {deciding.payerNote && (
                <Typography variant="body2" color="text.secondary">
                  {t("admin.buyerNote", { note: deciding.payerNote })}
                </Typography>
              )}

              {deciding.hasProof ? (
                <Button
                  size="small"
                  startIcon={<ImageIcon />}
                  onClick={() => viewProof(deciding.id)}
                  sx={{ alignSelf: "flex-start" }}
                >
                  {t("admin.viewScreenshot")}
                </Button>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t("admin.noScreenshot")}
                </Typography>
              )}

              <TextField
                label={t("admin.whatYouChecked")}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                fullWidth
                required
                multiline
                minRows={2}
                placeholder={t("admin.paymentNotePlaceholder")}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 2, position: "sticky", bottom: 0, bgcolor: "background.paper", zIndex: 1 }}>
          <Button onClick={() => setDeciding(null)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button color="error" variant="outlined" disabled={busy} onClick={() => decide("reject")}>
            {t("admin.notFoundReject")}
          </Button>
          <Button variant="contained" disabled={busy} onClick={() => decide("confirm")}>
            {deciding?.kind === "subscription"
              ? t("admin.confirmActivatePlan")
              : t("admin.confirmAddCredits")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
