import { useEffect, useState, type FormEvent } from "react";
import {
  Alert,
  Box,
  Button,
  CardContent,
  Checkbox,
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
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { GlassCard, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { EMPTY_NRC, NrcInput, nrcToString, type NrcValue } from "../components/NrcInput";
import { formatCalendarDate } from "../lib/date";
import { apiErrorMessage } from "../i18n/apiError";

interface Verification {
  id: string;
  status: string;
  result: string | null;
  createdAt: string;
  subjectName: string | null;
  dateOfBirth: string | null;
  // Set when a reviewer has parked the check waiting on an answer from us.
  infoRequest: string | null;
  infoRequestedAt: string | null;
}

const VERIFICATION_STATUSES = ["pending", "need_more_info", "record_confirmed", "not_found"] as const;

function displayVerificationStatus(status: string) {
  return status === "completed" ? "record_confirmed" : status;
}

export function VerificationsPage() {
  const { t } = useTranslation();
  const [fullName, setFullName] = useState("");
  const [nrc, setNrc] = useState<NrcValue>(EMPTY_NRC);
  // Composed from the picker rather than typed, so the string that gets
  // hashed is canonical by construction.
  const nationalId = nrcToString(nrc);
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Verification[]>([]);
  const [answering, setAnswering] = useState<Verification | null>(null);
  const [answer, setAnswer] = useState("");

  async function loadList() {
    try {
      const res = await api<{ items: Verification[] }>("/verifications");
      setItems(res.items);
    } catch {
      // Keep the initial list empty when it cannot be loaded.
    }
  }

  useEffect(() => {
    void loadList();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      await api<Verification>("/verifications", {
        method: "POST",
        body: {
          subject: {
            fullName,
            nationalId,
            dateOfBirth: dateOfBirth || undefined,
          },
          authorization: {
            confirmed: true,
          },
        },
      });
      setNotice(t("verifications.submitted"));
      setFullName("");
      setNrc(EMPTY_NRC);
      setDateOfBirth("");
      setConsentConfirmed(false);
      await loadList();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack spacing={3}>
      <PageHeader title={t("verifications.title")} subtitle={t("verifications.subtitle", { cost: 5 })} />

      <GlassCard>
        <CardContent>
          <form onSubmit={onSubmit}>
            <Stack spacing={2}>
              <Typography variant="subtitle1">{t("verifications.newCheck")}</Typography>
              {error && <Alert severity="error">{error}</Alert>}
              {notice && <Alert severity="success">{notice}</Alert>}
              <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
                <Stack spacing={2}>
                  <Typography variant="subtitle2">{t("verifications.personDetails")}</Typography>
                  <TextField label={t("verifications.fullName")} value={fullName} onChange={(e) => setFullName(e.target.value)} required fullWidth />
                  <NrcInput value={nrc} onChange={setNrc} required />
                  <TextField label={t("verifications.dobOptional")} type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} InputLabelProps={{ shrink: true }} fullWidth />
                </Stack>
              </Box>
              <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 2 }}>
                <Stack spacing={2}>
                  <Typography variant="subtitle2">{t("verifications.consentTitle")}</Typography>
                  <Alert severity="info">{t("verifications.consentHint")}</Alert>
                  <Stack direction="row" spacing={0.5} alignItems="flex-start">
                    <Checkbox
                      checked={consentConfirmed}
                      onChange={(e) => setConsentConfirmed(e.target.checked)}
                      inputProps={{ "aria-label": t("verifications.consentConfirm") }}
                    />
                    <Typography variant="body2" sx={{ pt: 1.15 }}>
                      {t("verifications.consentConfirm")}
                    </Typography>
                  </Stack>
                </Stack>
              </Box>
              <Alert severity="info" icon={false}>{t("verifications.creditCharge", { cost: 5 })}</Alert>
              <Button type="submit" variant="contained" disabled={loading || !nationalId || !consentConfirmed} sx={{ alignSelf: "flex-start" }}>
                {loading ? t("verifications.submitting") : t("verifications.submitCheckWithCost", { cost: 5 })}
              </Button>
            </Stack>
          </form>
        </CardContent>
      </GlassCard>

      <GlassCard>
        <CardContent>
          <Typography variant="subtitle1" gutterBottom>{t("verifications.recent")}</Typography>
          <Divider sx={{ mb: 1 }} />
          <Box sx={{ p: 1.5, mb: 2, borderRadius: 2, bgcolor: "rgba(47,107,255,0.055)", border: "1px solid rgba(47,107,255,0.12)" }}>
            <Typography variant="subtitle2" mb={1}>{t("verifications.statusGuide")}</Typography>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" }, gap: 1.25 }}>
              {VERIFICATION_STATUSES.map((status) => (
                <Stack key={status} direction="row" spacing={1} alignItems="center">
                  <Box sx={{ flexShrink: 0 }}><StatusChip status={status} /></Box>
                  <Typography variant="caption" color="text.secondary" lineHeight={1.45}>
                    {t(`verifications.statusHelp.${status}`)}
                  </Typography>
                </Stack>
              ))}
            </Box>
          </Box>
          {items.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{t("verifications.noChecks")}</Typography>
          ) : (
            <ScrollableTable minWidth={900}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("verifications.person")}</TableCell>
                  <TableCell>{t("verifications.dateOfBirth")}</TableCell>
                  <TableCell>{t("reports.reference")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell>{t("verifications.result")}</TableCell>
                  <TableCell>{t("verifications.created")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell>{v.subjectName ?? "—"}</TableCell>
                    <TableCell>{formatCalendarDate(v.dateOfBirth)}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>{v.id.slice(0, 8)}</TableCell>
                    <TableCell>
                      <StatusChip
                        status={displayVerificationStatus(v.status)}
                        tooltip={t(`verifications.statusHelp.${displayVerificationStatus(v.status)}`)}
                      />
                    </TableCell>
                    <TableCell>
                      {/* A parked check is only actionable if we say what is
                          being asked for and give them somewhere to answer. */}
                      {v.status === "need_more_info" && v.infoRequest ? (
                        <Stack spacing={0.5} alignItems="flex-start">
                          <Typography variant="body2">{v.infoRequest}</Typography>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => {
                              setAnswering(v);
                              setAnswer("");
                            }}
                          >
                            {t("verifications.answerReviewer")}
                          </Button>
                        </Stack>
                      ) : (
                        (v.result ?? "—")
                      )}
                    </TableCell>
                    <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </GlassCard>

      <Dialog open={answering !== null} onClose={() => setAnswering(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t("verifications.answerTitle")}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="info" icon={false}>
              <Typography variant="caption" fontWeight={700} display="block">
                {t("verifications.reviewerAsked")}
              </Typography>
              <Typography variant="body2">{answering?.infoRequest}</Typography>
            </Alert>
            <TextField
              label={t("verifications.yourAnswer")}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              fullWidth
              multiline
              minRows={3}
              autoFocus
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setAnswering(null)} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={loading || answer.trim().length === 0}
            onClick={async () => {
              if (!answering) return;
              setLoading(true);
              setError(null);
              try {
                await api(`/verifications/${answering.id}/respond`, {
                  method: "POST",
                  body: { answer: answer.trim() },
                });
                setAnswering(null);
                setNotice(t("verifications.answerSent"));
                await loadList();
              } catch (err) {
                setError(apiErrorMessage(err));
              } finally {
                setLoading(false);
              }
            }}
          >
            {t("common.submit")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
