import { useEffect, useState } from "react";
import { alpha } from "@mui/material/styles";
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
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { EmptyState, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatCalendarDate } from "../lib/date";
import { brand } from "../theme";

interface OversightItem {
  id: string;
  status: string;
  categoryName: string;
  companyName: string;
  subjectName: string;
  subjectDateOfBirth: string | null;
  evidenceCount: number;
  createdAt: string;
  expiryDate: string | null;
}

interface Counts {
  [status: string]: number;
}

interface ReportDetail {
  id: string;
  status: string;
  narrativeSummary: string | null;
  categoryName: string;
  companyName: string;
  subjectName: string;
  subjectDateOfBirth: string | null;
  subjectNationalId: string | null;
  subjectSince: string | null;
  createdAt: string;
  expiryDate: string | null;
  evidence: { id: string; contentType: string | null; uploadedAt: string }[];
}

const FILTERS = [
  { key: "", label: "admin.all" },
  { key: "pending_review", label: "status.pending_review" },
  { key: "approved", label: "status.approved" },
  { key: "rejected", label: "status.rejected" },
  { key: "withdrawn", label: "status.withdrawn" },
  { key: "expired", label: "status.expired" },
  { key: "draft", label: "status.draft" },
];

export function AdminOversightPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<OversightItem[]>([]);
  const [counts, setCounts] = useState<Counts>({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [mode, setMode] = useState<"none" | "withdraw" | "correct">("none");
  const [reason, setReason] = useState("");
  const [correctedSummary, setCorrectedSummary] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(nextStatus = status) {
    setError(null);
    try {
      const q = nextStatus ? `?status=${nextStatus}` : "";
      const res = await api<{ items: OversightItem[]; counts: Counts }>(`/admin/reports${q}`);
      setItems(res.items);
      setCounts(res.counts);
      setStatus(nextStatus);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load reports");
    }
  }

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDetail(id: string) {
    setError(null);
    setMode("none");
    setReason("");
    try {
      const d = await api<ReportDetail>(`/admin/reports/${id}/detail`);
      setDetail(d);
      setCorrectedSummary(d.narrativeSummary ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open report");
    }
  }

  async function runCorrection() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "withdraw") {
        await api(`/admin/reports/${detail.id}/withdraw`, {
          method: "POST",
          body: { reason },
        });
      } else if (mode === "correct") {
        await api(`/admin/reports/${detail.id}/correct`, {
          method: "POST",
          body: { narrativeSummary: correctedSummary, reason },
        });
      }
      setDetail(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadEvidence(reportId: string, fileId: string) {
    try {
      const { url } = await api<{ url: string }>(
        `/admin/reports/${reportId}/evidence/${fileId}/download`
      );
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open evidence");
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title={t("admin.oversightTitle")}
        subtitle={t("admin.oversightSubtitle")}
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {/* Filter bar with live counts */}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={3}>
        {FILTERS.map((f) => {
          const n = f.key ? counts[f.key] ?? 0 : total;
          const active = status === f.key;
          return (
            <Chip
              key={f.key || "all"}
              label={`${t(f.label)} · ${n}`}
              onClick={() => load(f.key)}
              variant={active ? "filled" : "outlined"}
              sx={{
                cursor: "pointer",
                fontWeight: 600,
                ...(active
                  ? { bgcolor: brand.primary, color: "#fff" }
                  : { borderColor: brand.border }),
              }}
            />
          );
        })}
      </Stack>

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState title={t("admin.noReportsInView")} />
          ) : (
            <ScrollableTable minWidth={900}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.person")}</TableCell>
                  <TableCell>{t("admin.dateOfBirth")}</TableCell>
                  <TableCell>{t("admin.category")}</TableCell>
                  <TableCell>{t("admin.submittedBy")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell>{t("admin.evidence")}</TableCell>
                  <TableCell>{t("common.created")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell>{r.subjectName}</TableCell>
                    <TableCell>
                      {formatCalendarDate(r.subjectDateOfBirth)}
                    </TableCell>
                    <TableCell>{r.categoryName}</TableCell>
                    <TableCell>{r.companyName}</TableCell>
                    <TableCell>
                      <StatusChip status={r.status} />
                    </TableCell>
                    <TableCell>{r.evidenceCount}</TableCell>
                    <TableCell>{new Date(r.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => openDetail(r.id)}>
                        {t("admin.openReport")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>

      {/* Audited detail dialog */}
      <Dialog open={detail !== null} onClose={() => setDetail(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {detail?.subjectName}
          <Typography variant="body2" color="text.secondary">
            {detail?.categoryName} · {detail?.companyName}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          {detail && (
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center">
                <StatusChip status={detail.status} />
                <Typography variant="caption" color="text.secondary">
                  created {new Date(detail.createdAt).toLocaleString()}
                </Typography>
              </Stack>

              <Box
                sx={{
                  borderRadius: 2,
                  border: `1px solid ${brand.border}`,
                  p: 1.5,
                }}
              >
                <Typography variant="caption" fontWeight={700} color="text.secondary">
                  {t("admin.reportedPerson").toUpperCase()}
                </Typography>
                <Typography variant="body2">
                  {detail.subjectName}
                  {detail.subjectDateOfBirth &&
                    ` · born ${formatCalendarDate(detail.subjectDateOfBirth)}`}
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                  NRC {detail.subjectNationalId ?? "— (filed before NRC was retained)"}
                </Typography>
              </Box>

              <Box
                sx={{
                  borderRadius: 2,
                  border: `1px solid ${brand.border}`,
                  p: 1.5,
                  bgcolor: alpha(brand.primary, 0.03),
                }}
              >
                <Typography variant="caption" fontWeight={700} color="text.secondary">
                  {t("admin.factualSummary").toUpperCase()}
                </Typography>
                <Typography variant="body2">
                  {detail.narrativeSummary ?? "— (removed on expiry)"}
                </Typography>
              </Box>

              <Typography variant="subtitle2">{t("admin.evidenceFiles")}</Typography>
              {detail.evidence.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("admin.noEvidence")}
                </Typography>
              ) : (
                detail.evidence.map((e, i) => (
                  <Stack key={e.id} direction="row" alignItems="center" spacing={1}>
                    <Typography variant="body2" flex={1}>
                      File {i + 1} · {e.contentType ?? "unknown"}
                    </Typography>
                    <Button
                      size="small"
                      startIcon={<DownloadIcon />}
                      onClick={() => downloadEvidence(detail.id, e.id)}
                    >
                      {t("admin.openFile")}
                    </Button>
                  </Stack>
                ))
              )}

              <Typography variant="caption" color="text.secondary">
                {t("admin.openedLogged")}
              </Typography>

              {/* Correction path — only for a currently-published report. */}
              {detail.status === "approved" && mode !== "none" && (
                <Stack spacing={1.5} sx={{ pt: 1 }}>
                  {mode === "correct" && (
                    <TextField
                      label={t("admin.correctedSummary")}
                      value={correctedSummary}
                      onChange={(e) => setCorrectedSummary(e.target.value)}
                      fullWidth
                      multiline
                      minRows={2}
                      inputProps={{ maxLength: 500 }}
                    />
                  )}
                  <TextField
                    label={mode === "withdraw" ? t("admin.reasonWithdrawal") : t("admin.reasonCorrection")}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    fullWidth
                    required
                    helperText={t("common.auditNote")}
                  />
                </Stack>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          {detail?.status === "approved" ? (
            mode === "none" ? (
              <>
                <Button color="inherit" onClick={() => setMode("correct")}>
                  {t("admin.correctSummary")}
                </Button>
                <Button color="error" onClick={() => setMode("withdraw")}>
                  {t("admin.withdraw")}
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => setMode("none")} disabled={busy}>
                  {t("common.back")}
                </Button>
                <Button
                  variant="contained"
                  color={mode === "withdraw" ? "error" : "primary"}
                  disabled={busy || reason.trim().length === 0}
                  onClick={runCorrection}
                >
                  {busy
                    ? t("admin.working")
                    : mode === "withdraw"
                      ? t("admin.confirmWithdrawal")
                      : t("admin.saveCorrection")}
                </Button>
              </>
            )
          ) : (
            <Button onClick={() => setDetail(null)}>{t("common.close")}</Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
