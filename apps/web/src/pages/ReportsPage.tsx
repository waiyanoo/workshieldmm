import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  CardContent,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import SendIcon from "@mui/icons-material/Send";
import DescriptionIcon from "@mui/icons-material/Description";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { api, uploadFile } from "../api/client";
import { EmptyState, GlassCard, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { EMPTY_NRC, NrcInput, nrcToString, type NrcValue } from "../components/NrcInput";
import { formatCalendarDate } from "../lib/date";
import { useTranslation } from "react-i18next";
import { DECLARATION_VERSIONS, currentDeclarationText } from "@hyper/shared";
import { apiErrorMessage } from "../i18n/apiError";

interface Category {
  id: string;
  key: string;
  name: string;
  evidenceRequirements: string;
}

interface EvidenceFile {
  id: string;
  contentType: string | null;
  byteSize: number | null;
  uploadedAt: string;
}

interface ReportDetail {
  id: string;
  status: string;
  categoryName: string | null;
  evidenceRequirements: string | null;
  narrativeSummary: string | null;
  subjectName: string | null;
  subjectNationalId: string | null;
  subjectDateOfBirth: string | null;
  createdAt: string;
  expiryDate: string | null;
  evidence: EvidenceFile[];
}

interface Report {
  id: string;
  categoryId: string;
  status: string;
  narrativeSummary: string | null;
  createdAt: string;
  expiryDate: string | null;
  evidence: EvidenceFile[];
}

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const [reports, setReports] = useState<Report[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Which report's evidence list is expanded.
  const [expanded, setExpanded] = useState<string | null>(null);

  // Detail + withdrawal.
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");

  // New-report form state
  const [fullName, setFullName] = useState("");
  const [nrc, setNrc] = useState<NrcValue>(EMPTY_NRC);
  const nationalId = nrcToString(nrc);
  const [categoryKey, setCategoryKey] = useState("");
  const [narrative, setNarrative] = useState("");
  const [saving, setSaving] = useState(false);
  const [submittingReportId, setSubmittingReportId] = useState<string | null>(null);
  const [submissionDeclarationAccepted, setSubmissionDeclarationAccepted] = useState(false);

  const categoryById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories]
  );
  const selectedCategory = categories.find((c) => c.key === categoryKey);
  const reportBeingSubmitted = reports.find((report) => report.id === submittingReportId) ?? null;

  async function load() {
    try {
      const [r, c] = await Promise.all([
        api<{ items: Report[] }>("/reports"),
        api<{ items: Category[] }>("/report-categories"),
      ]);
      setReports(r.items);
      setCategories(c.items);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api("/reports", {
        method: "POST",
        body: {
          subject: { fullName, nationalId },
          categoryKey,
          narrativeSummary: narrative,
        },
      });
      setCreating(false);
      setFullName("");
      setNrc(EMPTY_NRC);
      setCategoryKey("");
      setNarrative("");
      setNotice(t("reports.draftCreated"));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function onEvidence(reportId: string, file: File) {
    setBusyId(reportId);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await uploadFile(`/reports/${reportId}/evidence`, fd);
      setNotice(t("reports.evidenceAttached"));
      setExpanded(reportId); // reveal the file list so the upload is visibly there
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onSubmit(reportId: string) {
    setBusyId(reportId);
    setError(null);
    setNotice(null);
    try {
      await api(`/reports/${reportId}/submit`, {
        method: "POST",
        body: { declaration: { accepted: true, version: DECLARATION_VERSIONS.report_submission } },
      });
      setNotice(t("reports.submitted"));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function openDetail(id: string) {
    setError(null);
    setWithdrawing(false);
    setWithdrawReason("");
    try {
      setDetail(await api<ReportDetail>(`/reports/${id}`));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  async function confirmWithdraw() {
    if (!detail) return;
    setBusyId(detail.id);
    setError(null);
    try {
      const res = await api<{ creditsReversed: number }>(`/reports/${detail.id}/withdraw`, {
        method: "POST",
        body: { reason: withdrawReason },
      });
      setDetail(null);
      setNotice(
        res.creditsReversed > 0
          ? t("reports.withdrawnWithCredits", { count: res.creditsReversed })
          : t("reports.withdrawn")
      );
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title={t("reports.title")}
        subtitle={t("reports.subtitle")}
        action={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>
            {t("reports.newReport")}
          </Button>
        }
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}

      <GlassCard>
        <CardContent>
          {reports.length === 0 ? (
            <EmptyState
              title={t("reports.empty")}
              hint={t("reports.emptyHint")}
            />
          ) : (
            <ScrollableTable minWidth={860}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("reports.reference")}</TableCell>
                  <TableCell>{t("reports.category")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell>{t("reports.evidence")}</TableCell>
                  <TableCell>{t("common.created")}</TableCell>
                  <TableCell>{t("common.expires")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {reports.map((r) => (
                  <Fragment key={r.id}>
                  <TableRow hover>
                    <TableCell sx={{ fontFamily: "monospace" }}>{r.id.slice(0, 8)}</TableCell>
                    <TableCell>{categoryById.get(r.categoryId)?.name ?? "—"}</TableCell>
                    <TableCell>
                      <StatusChip status={r.status} />
                    </TableCell>
                    <TableCell>
                      {r.evidence.length === 0 ? (
                        <Typography variant="body2" color="error.main">
                          {t("reports.noEvidenceYet")}
                        </Typography>
                      ) : (
                        <Button
                          size="small"
                          startIcon={
                            expanded === r.id ? <ExpandLessIcon /> : <ExpandMoreIcon />
                          }
                          onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                        >
                          {t("reports.fileCount", { count: r.evidence.length })}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>{new Date(r.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>
                      {r.expiryDate ? new Date(r.expiryDate).toLocaleDateString() : "—"}
                    </TableCell>
                    <TableCell align="right">
                      <Stack
                        direction={{ xs: "column", md: "row" }}
                        spacing={1}
                        justifyContent="flex-end"
                        alignItems={{ xs: "stretch", md: "center" }}
                        sx={{ width: "100%" }}
                      >
                        <Button size="small" onClick={() => openDetail(r.id)}>
                          {t("common.view")}
                        </Button>
                      {r.status === "draft" && (
                        <>
                          <Button
                            size="small"
                            component="label"
                            startIcon={<UploadFileIcon />}
                            disabled={busyId === r.id}
                          >
                            {t("reports.uploadEvidence")}
                            <input
                              type="file"
                              hidden
                              accept="application/pdf,image/jpeg,image/png"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) void onEvidence(r.id, f);
                                e.target.value = "";
                              }}
                            />
                          </Button>
                          <Button
                            size="small"
                            variant="contained"
                            startIcon={<SendIcon />}
                            disabled={busyId === r.id}
                            onClick={() => {
                              setSubmittingReportId(r.id);
                              setSubmissionDeclarationAccepted(false);
                            }}
                          >
                            {t("common.submit")}
                          </Button>
                        </>
                      )}
                      </Stack>
                    </TableCell>
                  </TableRow>

                  {/* Attached evidence. Filenames are not stored — only the
                      type, size and upload time — so files are listed in
                      upload order. */}
                  <TableRow>
                    <TableCell colSpan={7} sx={{ py: 0, border: 0 }}>
                      <Collapse in={expanded === r.id} timeout="auto" unmountOnExit>
                        <Stack spacing={0.5} sx={{ py: 1.5, pl: 2 }}>
                          <Typography variant="caption" fontWeight={700} color="text.secondary">
                            {t("reports.attachedEvidence")}
                          </Typography>
                          {r.evidence.map((e, i) => (
                            <Stack
                              key={e.id}
                              direction="row"
                              spacing={1}
                              alignItems="center"
                              sx={{ color: "text.secondary" }}
                            >
                              <DescriptionIcon fontSize="small" />
                              <Typography variant="body2">
                                File {i + 1} · {e.contentType ?? "unknown type"}
                                {e.byteSize !== null &&
                                  ` · ${(e.byteSize / 1024).toFixed(0)} KB`}{" "}
                                · uploaded {new Date(e.uploadedAt).toLocaleString()}
                              </Typography>
                            </Stack>
                          ))}
                        </Stack>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                  </Fragment>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </GlassCard>

      {/* What was filed, and the option to retract it. */}
      <Dialog open={detail !== null} onClose={() => setDetail(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {detail?.subjectName ?? t("reports.title")}
          <Typography variant="body2" color="text.secondary">
            {detail?.categoryName} · filed{" "}
            {detail && new Date(detail.createdAt).toLocaleDateString()}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          {detail && (
            <Stack spacing={2}>
              <Stack direction="row" spacing={1} alignItems="center">
                <StatusChip status={detail.status} />
                {detail.expiryDate && (
                  <Typography variant="caption" color="text.secondary">
                    {t("common.expires")} {new Date(detail.expiryDate).toLocaleDateString()}
                  </Typography>
                )}
              </Stack>

              <Box>
                <Typography variant="caption" fontWeight={700} color="text.secondary">
                  {t("reports.personReported")}
                </Typography>
                <Typography variant="body2">{detail.subjectName}</Typography>
                <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                  {detail.subjectNationalId ?? t("reports.nrcNotRecorded")}
                </Typography>
                {detail.subjectDateOfBirth && (
                  <Typography variant="body2" color="text.secondary">
                    {t("reports.born", { date: formatCalendarDate(detail.subjectDateOfBirth) })}
                  </Typography>
                )}
              </Box>

              <Box>
                <Typography variant="caption" fontWeight={700} color="text.secondary">
                  {t("reports.whatYouReported")}
                </Typography>
                <Typography variant="body2">
                  {detail.narrativeSummary ?? "— (removed on expiry)"}
                </Typography>
              </Box>

              {detail.evidenceRequirements && (
                <Box>
                  <Typography variant="caption" fontWeight={700} color="text.secondary">
                  {t("reports.evidenceStandard")}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {detail.evidenceRequirements}
                  </Typography>
                </Box>
              )}

              <Box>
                <Typography variant="caption" fontWeight={700} color="text.secondary">
                  {t("reports.evidenceYouAttached")}
                </Typography>
                {detail.evidence.length === 0 ? (
                  <Typography variant="body2" color="error.main">
                    {t("common.none")}
                  </Typography>
                ) : (
                  detail.evidence.map((e, i) => (
                    <Typography key={e.id} variant="body2" color="text.secondary">
                      File {i + 1} · {e.contentType ?? "unknown type"} · uploaded{" "}
                      {new Date(e.uploadedAt).toLocaleString()}
                    </Typography>
                  ))
                )}
              </Box>

              {withdrawing && (
                <>
                  <Alert severity="warning">{t("reports.withdrawWarning")}</Alert>
                  <TextField
                    label={t("reports.withdrawReason")}
                    value={withdrawReason}
                    onChange={(e) => setWithdrawReason(e.target.value)}
                    fullWidth
                    required
                    multiline
                    minRows={2}
                    helperText={t("common.auditNote")}
                  />
                </>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          {detail?.status === "approved" ? (
            withdrawing ? (
              <>
                <Button onClick={() => setWithdrawing(false)} disabled={busyId === detail.id}>
                  {t("common.back")}
                </Button>
                <Button
                  color="error"
                  variant="contained"
                  disabled={withdrawReason.trim().length === 0 || busyId === detail.id}
                  onClick={confirmWithdraw}
                >
                  {t("reports.confirmWithdrawal")}
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => setDetail(null)}>{t("common.close")}</Button>
                <Button color="error" onClick={() => setWithdrawing(true)}>
                  {t("reports.withdrawReport")}
                </Button>
              </>
            )
          ) : (
            <Button onClick={() => setDetail(null)}>{t("common.close")}</Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={submittingReportId !== null} onClose={() => setSubmittingReportId(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t("reports.submitDeclarationTitle")}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="warning">{t("reports.submitDeclarationWarning")}</Alert>
            {reportBeingSubmitted && <Alert severity="info" icon={false}>
              <Typography variant="caption" fontWeight={700} display="block">{t("reports.submissionReview")}</Typography>
              <Typography variant="body2">{t("reports.reference")}: {reportBeingSubmitted.id.slice(0, 8)}</Typography>
              <Typography variant="body2">{t("reports.category")}: {categoryById.get(reportBeingSubmitted.categoryId)?.name ?? "—"}</Typography>
              <Typography variant="body2">{t("reports.evidence")}: {t("reports.fileCount", { count: reportBeingSubmitted.evidence.length })}</Typography>
              {reportBeingSubmitted.evidence.length === 0 && <Typography variant="body2" color="error.main">{t("reports.evidenceRequiredBeforeSubmit")}</Typography>}
            </Alert>}
            <FormControlLabel
              control={<Checkbox checked={submissionDeclarationAccepted} onChange={(e) => setSubmissionDeclarationAccepted(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  {/* Archived wording, not a locale string — see RegisterPage. */}
                  {currentDeclarationText("report_submission", i18n.language)}
                </Typography>
              }
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setSubmittingReportId(null)} disabled={busyId !== null}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            disabled={!submissionDeclarationAccepted || busyId !== null || !reportBeingSubmitted || reportBeingSubmitted.evidence.length === 0}
            onClick={() => {
              if (!submittingReportId) return;
              void onSubmit(submittingReportId);
              setSubmittingReportId(null);
            }}
          >
            {t("reports.confirmSubmit")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* New report dialog */}
      <Dialog open={creating} onClose={() => setCreating(false)} fullWidth maxWidth="sm">
        <form onSubmit={onCreate}>
          <DialogTitle>{t("reports.newReportTitle")}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} mt={1}>
              <Alert severity="warning">
                {t("reports.newReportWarning")}
              </Alert>
              <TextField
                label={t("reports.personName")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                fullWidth
              />
              <NrcInput value={nrc} onChange={setNrc} required />
              <TextField
                select
                label={t("reports.categoryLabel")}
                value={categoryKey}
                onChange={(e) => setCategoryKey(e.target.value)}
                required
                fullWidth
              >
                {categories.map((c) => (
                  <MenuItem key={c.key} value={c.key}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
              {selectedCategory && (
                <Alert severity="info" icon={false}>
                  <Typography variant="caption" fontWeight={700} display="block">
                    {t("reports.requiredEvidence")}
                  </Typography>
                  <Typography variant="body2">{selectedCategory.evidenceRequirements}</Typography>
                </Alert>
              )}
              <TextField
                label={t("reports.summaryLabel")}
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
                required
                fullWidth
                multiline
                minRows={3}
                inputProps={{ maxLength: 500 }}
                helperText={`${narrative.length}/500 — short and factual; tied to the category, no free-form allegations.`}
              />
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setCreating(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="contained" disabled={saving || !categoryKey}>
              {saving ? "Creating…" : "Create draft"}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}
