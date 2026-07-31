/**
 * The reviewer work queue.
 *
 * A reviewer opens this to answer four questions — what is mine, what is
 * nobody's, what is overdue, and what am I waiting on the employer for — so
 * those are the filters, and the counts above them are the answers.
 *
 * The decision dialog is unchanged in substance from the plain list it
 * replaces: the "we hold no employment records" warning and the caveat on prior
 * attestations are the reason a reviewer does not simply copy the last answer,
 * and they matter more now that the queue makes it faster to work through.
 */
import { useCallback, useEffect, useState } from "react";
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
  Divider,
  MenuItem,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import PanToolAltIcon from "@mui/icons-material/PanToolAlt";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import InboxIcon from "@mui/icons-material/Inbox";
import AssignmentIndIcon from "@mui/icons-material/AssignmentInd";
import SpeedIcon from "@mui/icons-material/Speed";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { useAuth } from "../auth/AuthContext";
import { EmptyState, PageHeader, ScrollableTable, StatCard, StatusChip } from "../components/ui";
import { formatCalendarDate, formatDateTime } from "../lib/date";

interface QueueItem {
  id: string;
  companyName: string;
  subjectName: string;
  nationalId: string | null;
  dateOfBirth: string | null;
  status: string;
  result: string | null;
  createdAt: string;
  decidedAt: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  reviewerNote: string | null;
  infoRequest: string | null;
  requestedByName: string | null;
  ageHours: number;
}

interface Stats {
  byStatus: Record<string, { count: number; oldest: string | null }>;
  mine: number;
  unassigned: number;
  overdue: number;
  turnaround: {
    decided: number;
    avgHours: number | null;
    medianHours: number | null;
    p90Hours: number | null;
  };
}

interface VerificationContext {
  subject: {
    fullName: string | null;
    nationalId: string | null;
    dateOfBirth: string | null;
    knownSince: string | null;
  };
  priorChecks: {
    companyName: string;
    status: string;
    result: string | null;
    createdAt: string;
    isSameCompany: boolean;
  }[];
  publishedReports: { categoryName: string; status: string; createdAt: string }[];
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Hours as something a person reads: "3h", "2d 4h". */
function age(hours: number, t: Translate): string {
  if (hours < 1) return t("queue.underAnHour");
  if (hours < 24) return t("queue.hoursShort", { count: Math.round(hours) });
  return t("queue.daysShort", {
    days: Math.floor(hours / 24),
    hours: Math.round(hours % 24),
  });
}

export function AdminVerificationsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [items, setItems] = useState<QueueItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Filters
  const [status, setStatus] = useState("pending");
  const [assignment, setAssignment] = useState("all");
  const [q, setQ] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  // Decision dialog
  const [deciding, setDeciding] = useState<QueueItem | null>(null);
  const [context, setContext] = useState<VerificationContext | null>(null);
  const [result, setResult] = useState("");
  const [note, setNote] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ status, assignment });
      if (q.trim()) params.set("q", q.trim());
      if (overdueOnly) params.set("olderThanHours", "24");
      const [queue, s] = await Promise.all([
        api<{ items: QueueItem[] }>(`/admin/verifications?${params}`),
        api<Stats>("/admin/verifications-stats"),
      ]);
      setItems(queue.items);
      setStats(s);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [status, assignment, q, overdueOnly]);

  useEffect(() => {
    // Debounced, so typing in the search box does not fire a request per key.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function claim(item: QueueItem) {
    setBusy(true);
    try {
      await api(`/admin/verifications/${item.id}/assign`, {
        method: "POST",
        // Clicking the button on an item you already hold releases it.
        body: { to: item.assignedTo === user?.id ? null : (user?.id ?? null) },
      });
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function openReview(v: QueueItem) {
    setDeciding(v);
    setContext(null);
    setResult("");
    setNote(v.reviewerNote ?? "");
    setQuestion("");
    setAsking(false);
    try {
      setContext(await api<VerificationContext>(`/admin/verifications/${v.id}/context`));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  async function decide(next: "completed" | "not_found") {
    if (!deciding) return;
    setBusy(true);
    try {
      // The note is saved first: if it says "called HR, line disconnected", it
      // should survive even when the decision below fails.
      if (note.trim() !== (deciding.reviewerNote ?? "")) {
        await api(`/admin/verifications/${deciding.id}/note`, {
          method: "POST",
          body: { note: note.trim() },
        });
      }
      await api(`/admin/verifications/${deciding.id}/decision`, {
        method: "POST",
        body: { status: next, result: result || undefined },
      });
      setDeciding(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function askEmployer() {
    if (!deciding) return;
    setBusy(true);
    try {
      await api(`/admin/verifications/${deciding.id}/request-info`, {
        method: "POST",
        body: { question: question.trim() },
      });
      setDeciding(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const median = stats?.turnaround.medianHours;

  return (
    <Stack spacing={3}>
      <PageHeader title={t("admin.checkQueueTitle")} subtitle={t("admin.checkQueueSubtitle")} />
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {stats && (
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          <StatCard
            label={t("queue.waiting")}
            value={stats.byStatus.pending?.count ?? 0}
            icon={<InboxIcon />}
          />
          <StatCard
            label={t("queue.assignedToMe")}
            value={stats.mine}
            icon={<AssignmentIndIcon />}
            tone="#0E9384"
          />
          <StatCard
            label={t("queue.overdue")}
            value={stats.overdue}
            icon={<AccessTimeIcon />}
            tone={stats.overdue > 0 ? "#B42318" : "#475467"}
          />
          <StatCard
            label={t("queue.medianTurnaround")}
            value={median === null || median === undefined ? "—" : age(median, t)}
            icon={<SpeedIcon />}
            tone="#6941C6"
          />
        </Stack>
      )}

      <Card>
        <CardContent>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            alignItems={{ md: "center" }}
            mb={2}
          >
            <TextField
              select
              size="small"
              label={t("common.status")}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              sx={{ minWidth: 190 }}
            >
              {["pending", "need_more_info", "completed", "not_found", "all"].map((s) => (
                <MenuItem key={s} value={s}>
                  {s === "all" ? t("queue.allStatuses") : t(`status.${s}`, { defaultValue: s })}
                </MenuItem>
              ))}
            </TextField>

            <ToggleButtonGroup
              size="small"
              exclusive
              value={assignment}
              onChange={(_, v) => v && setAssignment(v)}
            >
              <ToggleButton value="all">{t("queue.everyone")}</ToggleButton>
              <ToggleButton value="me">{t("queue.mine")}</ToggleButton>
              <ToggleButton value="unassigned">{t("queue.unclaimed")}</ToggleButton>
            </ToggleButtonGroup>

            <TextField
              size="small"
              label={t("queue.search")}
              placeholder={t("queue.searchPlaceholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              sx={{ flex: 1, minWidth: 220 }}
            />

            <ToggleButton
              size="small"
              value="overdue"
              selected={overdueOnly}
              onChange={() => setOverdueOnly((v) => !v)}
            >
              {t("queue.overdueOnly")}
            </ToggleButton>
          </Stack>

          {items.length === 0 ? (
            <EmptyState title={t("admin.noChecks")} hint={t("queue.noneMatch")} />
          ) : (
            <ScrollableTable minWidth={1080}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.applicant")}</TableCell>
                  <TableCell>{t("admin.nrc")}</TableCell>
                  <TableCell>{t("admin.requestedBy")}</TableCell>
                  <TableCell>{t("queue.waitingFor")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell>{t("queue.assignee")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((v) => {
                  const isMine = v.assignedTo === user?.id;
                  const open = v.status === "pending" || v.status === "need_more_info";
                  return (
                    <TableRow key={v.id}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>
                          {v.subjectName}
                        </Typography>
                        {v.dateOfBirth && (
                          <Typography variant="caption" color="text.secondary">
                            {t("admin.dateOfBirth")}: {formatCalendarDate(v.dateOfBirth)}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ fontFamily: "monospace", fontSize: 13 }}>
                        {v.nationalId ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{v.companyName}</Typography>
                        {v.requestedByName && (
                          <Typography variant="caption" color="text.secondary">
                            {v.requestedByName}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          color={
                            v.ageHours > 24 && v.status === "pending" ? "error.main" : undefined
                          }
                        >
                          {age(v.ageHours, t)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <StatusChip status={v.status} />
                        {v.infoRequest && (
                          <Tooltip title={v.infoRequest}>
                            <HelpOutlineIcon
                              sx={{
                                fontSize: 15,
                                ml: 0.5,
                                color: "warning.main",
                                verticalAlign: "middle",
                              }}
                            />
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        {v.assignedName ? (
                          <Chip
                            size="small"
                            label={isMine ? t("queue.you") : v.assignedName}
                            color={isMine ? "primary" : "default"}
                            variant={isMine ? "filled" : "outlined"}
                          />
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {t("queue.unclaimed")}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          {open && (
                            <Button
                              size="small"
                              disabled={busy}
                              startIcon={<PanToolAltIcon />}
                              onClick={() => void claim(v)}
                            >
                              {isMine ? t("queue.release") : t("queue.claim")}
                            </Button>
                          )}
                          <Button
                            size="small"
                            variant="contained"
                            disabled={!open}
                            onClick={() => void openReview(v)}
                          >
                            {t("admin.review")}
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>

      {/* --- Review + decision --- */}
      <Dialog open={deciding !== null} onClose={() => setDeciding(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {t("admin.completeCheck")} — {deciding?.subjectName}
          <Typography variant="body2" color="text.secondary">
            NRC {deciding?.nationalId ?? "—"}
            {deciding?.dateOfBirth && ` · ${formatCalendarDate(deciding.dateOfBirth)}`}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="warning" icon={false}>
              <Typography variant="caption" fontWeight={700} display="block">
                {t("admin.noEmploymentRecords")}
              </Typography>
              <Typography variant="body2">{t("admin.noEmploymentRecordsBody")}</Typography>
            </Alert>

            {deciding?.infoRequest && (
              <Alert severity="info" icon={false}>
                <Typography variant="caption" fontWeight={700} display="block">
                  {t("queue.awaitingEmployer")}
                </Typography>
                <Typography variant="body2">{deciding.infoRequest}</Typography>
              </Alert>
            )}

            <Typography variant="subtitle2">{t("admin.previousDecisions")}</Typography>
            {context === null ? (
              <Typography variant="body2" color="text.secondary">
                {t("common.loading")}
              </Typography>
            ) : (
              <Stack spacing={1}>
                <Typography variant="body2">
                  {context.subject.knownSince
                    ? t("admin.firstSeen", { date: formatDateTime(context.subject.knownSince) })
                    : t("admin.notPreviouslySeen")}
                </Typography>

                <Typography variant="body2">
                  {context.priorChecks.length === 0
                    ? t("admin.noOtherChecks")
                    : t("admin.otherChecks", { count: context.priorChecks.length })}
                </Typography>

                {/* Past reviewer attestations, not evidence. Labelled as such so
                    a reviewer does not copy the previous answer and turn one
                    unverified claim into an apparent consensus. */}
                {context.priorChecks.map((c, i) => (
                  <Typography key={i} variant="body2" color="text.secondary" sx={{ pl: 2 }}>
                    {c.isSameCompany ? t("admin.sameCompany") : c.companyName} ·{" "}
                    {t(`status.${c.status}`, { defaultValue: c.status })} ·{" "}
                    {formatDateTime(c.createdAt)}
                    {c.result && (
                      <>
                        <br />
                        <em>
                          {t("admin.reviewerWrote")} &ldquo;{c.result}&rdquo;
                        </em>
                      </>
                    )}
                  </Typography>
                ))}
                {context.priorChecks.length > 0 && (
                  <Typography variant="caption" color="warning.main" sx={{ pl: 2 }}>
                    {t("admin.priorChecksCaveat")}
                  </Typography>
                )}

                {context.publishedReports.length > 0 && (
                  <Alert severity="error" icon={false}>
                    <Typography variant="caption" fontWeight={700} display="block">
                      {t("admin.publishedReportsCount", {
                        count: context.publishedReports.length,
                      })}
                    </Typography>
                    {context.publishedReports.map((r, i) => (
                      <Typography key={i} variant="body2">
                        {r.categoryName} · {formatDateTime(r.createdAt)}
                      </Typography>
                    ))}
                  </Alert>
                )}
              </Stack>
            )}

            <Divider />

            {/* Internal. The helper text says so, so nobody writes something
                here expecting the employer to read it. */}
            <TextField
              label={t("queue.reviewerNote")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
              multiline
              minRows={2}
              helperText={t("queue.reviewerNoteHelp")}
            />

            {asking ? (
              <TextField
                label={t("queue.questionForEmployer")}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                fullWidth
                multiline
                minRows={2}
                autoFocus
                helperText={t("queue.questionHelp")}
              />
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  {t("admin.recordOutcome")}
                </Typography>
                <TextField
                  label={t("admin.resultOptional")}
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  fullWidth
                  multiline
                  minRows={2}
                />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, flexWrap: "wrap" }}>
          <Button onClick={() => setDeciding(null)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Box flex={1} />
          {asking ? (
            <>
              <Button onClick={() => setAsking(false)} disabled={busy}>
                {t("common.back")}
              </Button>
              <Button
                variant="contained"
                color="warning"
                disabled={busy || question.trim().length === 0}
                onClick={() => void askEmployer()}
              >
                {t("queue.sendQuestion")}
              </Button>
            </>
          ) : (
            <>
              <Button
                color="warning"
                startIcon={<HelpOutlineIcon />}
                disabled={busy || deciding?.status === "need_more_info"}
                onClick={() => setAsking(true)}
              >
                {t("queue.needMoreInfo")}
              </Button>
              <Button
                color="inherit"
                variant="outlined"
                disabled={busy}
                onClick={() => void decide("not_found")}
              >
                {t("admin.noRecordFound")}
              </Button>
              <Button
                variant="contained"
                color="success"
                disabled={busy}
                onClick={() => void decide("completed")}
              >
                {t("admin.recordConfirmed")}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
