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
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tab,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import ImageIcon from "@mui/icons-material/Image";
import { useTranslation } from "react-i18next";
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
  const [status, setStatus] = useState("submitted");
  const [items, setItems] = useState<PaymentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<PaymentItem | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(next = status) {
    setError(null);
    try {
      const res = await api<{ items: PaymentItem[] }>(`/admin/payments?status=${next}`);
      setItems(res.items);
      setStatus(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load payments");
    }
  }

  useEffect(() => {
    void load("submitted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function viewProof(id: string) {
    try {
      const { url } = await api<{ url: string }>(`/admin/payments/${id}/proof`);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open the screenshot");
    }
  }

  async function decide(decision: "confirm" | "reject") {
    if (!deciding) return;
    if (!note.trim()) {
      setError("A note is required — it is the record of what you checked.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/payments/${deciding.id}/decision`, {
        method: "POST",
        body: { decision, note },
      });
      setDeciding(null);
      setNote("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Decision failed");
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

      <Tabs value={status} onChange={(_e, v: string) => void load(v)} sx={{ mb: 2 }}>
        <Tab label={t("admin.awaitingConfirmation")} value="submitted" />
        <Tab label={t("admin.confirmedTab")} value="confirmed" />
        <Tab label={t("admin.rejectedTab")} value="rejected" />
        <Tab label={t("admin.unpaidTab")} value="awaiting_payment" />
      </Tabs>

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState title={t("admin.nothingHere")} />
          ) : (
            <ScrollableTable minWidth={940}>
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
                          {t("admin.reconcile")}
                        </Button>
                      ) : (
                        <StatusChip status={p.status} />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>

      <Dialog open={deciding !== null} onClose={() => setDeciding(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {t("admin.reconcile")} {deciding?.referenceCode}
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
                  Amount: <b>{mmk(deciding.amountMmk)}</b>
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
                placeholder="e.g. Matched KBZPay statement line 14:32, ref WS-XXXX, 49,900 MMK"
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setDeciding(null)} disabled={busy}>
            Cancel
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
