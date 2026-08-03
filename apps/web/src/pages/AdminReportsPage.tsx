import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import DescriptionIcon from "@mui/icons-material/Description";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { BentoStatCard, EmptyState, GlassCard, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatCalendarDate } from "../lib/date";

interface QueueItem {
  id: string;
  subjectName: string;
  subjectDateOfBirth: string | null;
  subjectNationalId: string | null;
  companyName: string;
  categoryName: string;
  evidenceCount: number;
  createdAt: string;
}

interface ReportDetail {
  id: string;
  status: string;
  narrativeSummary: string | null;
  categoryName: string;
  evidenceRequirements: string;
  companyName: string;
  subjectName: string;
  createdAt: string;
  subjectDateOfBirth: string | null;
  subjectNationalId: string | null;
  evidence: { id: string; contentType: string | null; uploadedAt: string }[];
}

export function AdminReportsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await api<{ items: QueueItem[] }>("/admin/reports/pending");
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load review queue");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function openDetail(id: string) {
    setError(null);
    try {
      setDetail(await api<ReportDetail>(`/admin/reports/${id}/detail`));
      setNotes("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load report");
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

  async function decide(decision: "evidence_sufficient" | "evidence_insufficient") {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/reports/${detail.id}/decision`, {
        method: "POST",
        body: { decision, notes: notes || undefined },
      });
      setDetail(null);
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
        title={t("admin.reportReviewTitle")}
        subtitle={t("admin.reportReviewSubtitle")}
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "minmax(0, 260px)" }, gap: 2, mb: 2 }}>
        <BentoStatCard label={t("admin.reportReviewTitle")} value={items.length} icon={<DescriptionIcon />} tone="#9F1AB1" />
      </Box>

      <GlassCard>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState title={t("admin.noReportsToReview")} />
          ) : (
            <ScrollableTable minWidth={940}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.person")}</TableCell>
                  <TableCell>{t("admin.nrc")}</TableCell>
                  <TableCell>{t("admin.dateOfBirth")}</TableCell>
                  <TableCell>{t("admin.submittedBy")}</TableCell>
                  <TableCell>{t("admin.category")}</TableCell>
                  <TableCell>{t("admin.evidence")}</TableCell>
                  <TableCell>{t("admin.submittedAt")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell>{r.subjectName}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {r.subjectNationalId ?? "—"}
                    </TableCell>
                    <TableCell>
                      {formatCalendarDate(r.subjectDateOfBirth)}
                    </TableCell>
                    <TableCell>{r.companyName}</TableCell>
                    <TableCell>{r.categoryName}</TableCell>
                    <TableCell>{t("admin.fileCount", { count: r.evidenceCount })}</TableCell>
                    <TableCell>{new Date(r.createdAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Button size="small" variant="contained" onClick={() => openDetail(r.id)}>
                        {t("admin.review")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </GlassCard>

      <Dialog open={detail !== null} onClose={() => setDetail(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {t("admin.review")} — {detail?.subjectName}
          <Typography variant="body2" color="text.secondary">
            NRC {detail?.subjectNationalId ?? "—"} · {detail?.categoryName} · submitted by{" "}
            {detail?.companyName}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          {detail && (
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center">
                <StatusChip status={detail.status} />
                <Typography variant="caption" color="text.secondary">
                  filed {new Date(detail.createdAt).toLocaleString()}
                </Typography>
              </Stack>

              <Alert severity="info" icon={false}>
                <Typography variant="caption" fontWeight={700} display="block">
                  {t("admin.factualSummary")}
                </Typography>
                <Typography variant="body2">{detail.narrativeSummary}</Typography>
              </Alert>

              <Alert severity="warning" icon={false}>
                <Typography variant="caption" fontWeight={700} display="block">
                  {t("admin.evidenceBar")}
                </Typography>
                <Typography variant="body2">{detail.evidenceRequirements}</Typography>
              </Alert>

              <Divider />
              <Typography variant="subtitle2">{t("admin.evidenceFiles")}</Typography>
              {detail.evidence.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("admin.noEvidence")}
                </Typography>
              ) : (
                detail.evidence.map((e, i) => (
                  <Stack key={e.id} direction="row" alignItems="center" spacing={1}>
                    <Typography variant="body2" flex={1}>
                      File {i + 1} · {e.contentType ?? "unknown"} ·{" "}
                      {new Date(e.uploadedAt).toLocaleString()}
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

              <TextField
                label={t("admin.reviewNotes")}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                fullWidth
                multiline
                minRows={2}
              />
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setDetail(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="outlined"
            disabled={busy}
            onClick={() => decide("evidence_insufficient")}
          >
            {t("admin.rejectInsufficient")}
          </Button>
          <Button variant="contained" disabled={busy} onClick={() => decide("evidence_sufficient")}>
            {t("admin.acceptPublish")}
          </Button>
        </DialogActions>
      </Dialog>

    </>
  );
}
