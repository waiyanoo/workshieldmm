/**
 * Payment history, receipts, and what is about to expire.
 *
 * Three things a finance person opens this page for, in order: proof of a
 * payment, the date the subscription renews, and the date credits stop working.
 * The third is the one companies get caught by, so it is on the page rather
 * than only on the receipt.
 *
 * The receipt itself prints. `@media print` hides the app shell and the
 * controls, so Ctrl+P produces a document rather than a screenshot of a web
 * page — there is no PDF generator on the server, and a browser's print-to-PDF
 * is a better one than anything worth writing here.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import PrintIcon from "@mui/icons-material/Print";
import ReceiptLongIcon from "@mui/icons-material/ReceiptLong";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { EmptyState, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatDateTime } from "../lib/date";

interface Payment {
  id: string;
  referenceCode: string;
  receiptNumber: string | null;
  kind: string;
  plan: string | null;
  billingCycle: string | null;
  credits: number;
  amountMmk: number;
  provider: string;
  status: string;
  payerReference: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface Receipt {
  receiptNumber: string | null;
  referenceCode: string;
  payerReference: string | null;
  issuedAt: string | null;
  paidBy: {
    companyName: string;
    registrationNumber: string;
    address: string | null;
    contactEmail: string | null;
    phone: string | null;
    purchasedByName: string | null;
  };
  lines: { kind: string; description: string; credits: number | null; amountMmk: number }[];
  totalMmk: number;
  currency: string;
  payment: { method: string; provider: string; status: string };
  credits: { purchased: number; remaining: number | null; expiresAt: string | null } | null;
  subscription: {
    plan: string | null;
    planName: string | null;
    billingCycle: string | null;
    periodStartsAt: string | null;
    renewsAt: string | null;
  } | null;
}

interface CreditSummary {
  balance: number;
  expiring: { remaining: number; expiresAt: string; reason: string }[];
}

const mmk = (n: number) => `${n.toLocaleString()} MMK`;

export function ReceiptsPage() {
  const { t } = useTranslation();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [credits, setCredits] = useState<CreditSummary | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ items: Payment[] }>("/payments")
      .then((r) => setPayments(r.items))
      .catch((err) => setError(apiErrorMessage(err)));
    void api<CreditSummary>("/credits")
      .then(setCredits)
      .catch(() => {
        // The balance panel is supplementary; the history below is the page.
      });
  }, []);

  return (
    <Stack spacing={3}>
      <PageHeader title={t("receipts.title")} subtitle={t("receipts.subtitle")} />
      {error && <Alert severity="error">{error}</Alert>}

      {/* What lapses next. Sorted earliest-first by the API, which is also the
          order credits are spent in. */}
      {credits && credits.expiring.length > 0 && (
        <Card>
          <CardContent>
            <Typography variant="subtitle2" mb={1.5}>
              {t("receipts.expiringTitle", { balance: credits.balance })}
            </Typography>
            <ScrollableTable minWidth={520}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("receipts.creditSource")}</TableCell>
                  <TableCell align="right">{t("receipts.remaining")}</TableCell>
                  <TableCell>{t("receipts.usableUntil")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {credits.expiring.map((lot, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      {t(`receipts.lotReason.${lot.reason}`, { defaultValue: lot.reason })}
                    </TableCell>
                    <TableCell align="right">{lot.remaining}</TableCell>
                    <TableCell>{formatDateTime(lot.expiresAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
            <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
              {t("receipts.expiryNote")}
            </Typography>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="subtitle2" mb={1.5}>
            {t("receipts.history")}
          </Typography>
          {payments.length === 0 ? (
            <EmptyState title={t("receipts.noPayments")} hint={t("receipts.noPaymentsHint")} />
          ) : (
            <ScrollableTable minWidth={900}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("receipts.date")}</TableCell>
                  <TableCell>{t("receipts.item")}</TableCell>
                  <TableCell align="right">{t("receipts.amount")}</TableCell>
                  <TableCell>{t("receipts.reference")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell align="right">{t("receipts.receiptNo")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{formatDateTime(p.createdAt)}</TableCell>
                    <TableCell>
                      {p.kind === "subscription"
                        ? t("receipts.planItem", {
                            // The plan key is the product name and is not
                            // translated — "Starter" is what the price list says.
                            plan: p.plan,
                            cycle: t(`receipts.cycle.${p.billingCycle}`, {
                              defaultValue: p.billingCycle ?? "",
                            }),
                          })
                        : t("receipts.creditItem", { count: p.credits })}
                    </TableCell>
                    <TableCell align="right">{mmk(p.amountMmk)}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace", fontSize: 13 }}>
                      {p.referenceCode}
                    </TableCell>
                    <TableCell>
                      <StatusChip status={p.status} />
                      {p.status === "rejected" && p.decisionNote && (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {p.decisionNote}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {p.status === "confirmed" ? (
                        <Button
                          size="small"
                          startIcon={<ReceiptLongIcon />}
                          onClick={() =>
                            void api<Receipt>(`/payments/${p.id}/receipt`)
                              .then(setReceipt)
                              .catch((err) => setError(apiErrorMessage(err)))
                          }
                        >
                          {p.receiptNumber ?? t("receipts.view")}
                        </Button>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          {t("receipts.noReceiptYet")}
                        </Typography>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>

      <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />
    </Stack>
  );
}

// --- The printable document ------------------------------------------------------

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" fontWeight={700} display="block">
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}

function ReceiptDialog({ receipt, onClose }: { receipt: Receipt | null; onClose: () => void }) {
  const { t } = useTranslation();
  if (!receipt) return null;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      {/* Print rules live with the thing they print. `#receipt-print` is
          promoted to the whole page so the dialog's own scroll container and
          backdrop do not clip it to one sheet. */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #receipt-print, #receipt-print * { visibility: visible !important; }
          #receipt-print {
            position: absolute; left: 0; top: 0; width: 100%;
            padding: 24px; box-shadow: none;
          }
          .no-print { display: none !important; }
        }
      `}</style>

      <DialogContent dividers id="receipt-print">
        <Stack spacing={2.5}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Box>
              <Typography variant="h6">WorkShield MM</Typography>
              <Typography variant="caption" color="text.secondary">
                {t("receipts.docTitle")}
              </Typography>
            </Box>
            <Box textAlign="right">
              <Typography variant="subtitle2" fontFamily="monospace">
                {receipt.receiptNumber ?? "—"}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {receipt.issuedAt ? formatDateTime(receipt.issuedAt) : "—"}
              </Typography>
            </Box>
          </Stack>

          <Divider />

          <Stack direction={{ xs: "column", sm: "row" }} spacing={3}>
            <Stack spacing={1} flex={1}>
              <Field label={t("receipts.billedTo")} value={receipt.paidBy.companyName} />
              <Typography variant="body2" color="text.secondary">
                {t("receipts.regNo")}: {receipt.paidBy.registrationNumber}
              </Typography>
              {receipt.paidBy.address && (
                <Typography variant="body2" color="text.secondary">
                  {receipt.paidBy.address}
                </Typography>
              )}
              {receipt.paidBy.contactEmail && (
                <Typography variant="body2" color="text.secondary">
                  {receipt.paidBy.contactEmail}
                </Typography>
              )}
            </Stack>
            <Stack spacing={1} flex={1}>
              <Field label={t("receipts.paidWith")} value={receipt.payment.method} />
              {/* Both numbers: ours for support, theirs for their bank. */}
              <Field label={t("receipts.reference")} value={receipt.referenceCode} />
              {receipt.payerReference && (
                <Field label={t("receipts.txnNumber")} value={receipt.payerReference} />
              )}
              {receipt.paidBy.purchasedByName && (
                <Field label={t("receipts.purchasedBy")} value={receipt.paidBy.purchasedByName} />
              )}
            </Stack>
          </Stack>

          <Divider />

          <ScrollableTable minWidth={380}>
            <TableHead>
              <TableRow>
                <TableCell>{t("receipts.description")}</TableCell>
                <TableCell align="right">{t("receipts.amount")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {receipt.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell>{l.description}</TableCell>
                  <TableCell align="right">{mmk(l.amountMmk)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell>
                  <Typography fontWeight={700}>{t("receipts.total")}</Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography fontWeight={700}>{mmk(receipt.totalMmk)}</Typography>
                </TableCell>
              </TableRow>
            </TableBody>
          </ScrollableTable>

          {receipt.credits?.expiresAt && (
            <Alert severity="info" icon={false}>
              <Typography variant="body2">
                {t("receipts.creditsExpiryLine", {
                  count: receipt.credits.purchased,
                  date: formatDateTime(receipt.credits.expiresAt),
                })}
              </Typography>
            </Alert>
          )}

          {receipt.subscription?.renewsAt && (
            <Alert severity="info" icon={false}>
              <Typography variant="body2">
                {t("receipts.renewsLine", {
                  plan: receipt.subscription.planName ?? receipt.subscription.plan,
                  date: formatDateTime(receipt.subscription.renewsAt),
                })}
              </Typography>
            </Alert>
          )}

          <Typography variant="caption" color="text.secondary">
            {t("receipts.footnote")}
          </Typography>
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }} className="no-print">
        <Button onClick={onClose}>{t("common.close")}</Button>
        <Button variant="contained" startIcon={<PrintIcon />} onClick={() => window.print()}>
          {t("receipts.print")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
