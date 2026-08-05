/**
 * One company, in full — and the place verification is decided.
 *
 * Verification used to be a button on a table row. That is the wrong shape for
 * the decision: approving a company is the platform vouching that a real,
 * registered business is behind an account that will go on to read people's
 * NRCs, and it was a single click taken with nothing on screen but a legal name.
 *
 * So the decision lives next to the evidence. The page shows every uploaded
 * document with its own approve/reject control, and the Verify button is
 * disabled until the required set is approved, naming what is still outstanding
 * instead of failing after the fact. A dialog was tried first and could not hold
 * the document list, the review controls and the rest of the record at a size
 * anyone could read.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
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
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import VerifiedIcon from "@mui/icons-material/Verified";
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { CompanyDocuments } from "../components/CompanyDocuments";
import { PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatCalendarDate, formatDateTime } from "../lib/date";

interface CompanyDetail {
  id: string;
  legalName: string;
  registrationNumber: string;
  status: string;
  registrationVerifiedAt: string | null;
  createdAt: string;
  plan: string;
  monthlyCreditOverride: number | null;
  creditBalance: number;
  users: {
    id: string;
    fullName: string;
    email: string;
    role: string;
    status: string;
    createdAt: string;
    nationalId: string | null;
  }[];
  subscriptions: {
    tier: string;
    status: string;
    billingCycle: string;
    startDate: string;
    endDate: string | null;
  }[];
  documents: {
    docType: string;
    uploadedAt: string;
    reviewStatus: "pending" | "approved" | "rejected";
  }[];
  /** Evaluated server-side from the same rule the verify endpoint enforces. */
  verification: { ready: boolean; missing: string[] };
  counts: { verifications: number; reports: number };
}

const PLANS = [
  { key: "free", label: "Free", fee: "0 MMK", credits: "10 welcome credits" },
  { key: "starter", label: "Starter", fee: "49,900 MMK", credits: "100 credits/month" },
  { key: "growth", label: "Growth", fee: "149,000 MMK", credits: "500 credits/month" },
  { key: "enterprise", label: "Enterprise", fee: "Custom", credits: "Negotiated" },
];

export function AdminCompanyDetailPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnQuery = searchParams.get("return");
  const backTo = searchParams.get("from") === "operations" ? "/admin/operations" : `/admin/companies${returnQuery ? `?${returnQuery}` : ""}`;

  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Verify / suspend / reactivate
  const [verifying, setVerifying] = useState(false);
  const [verifyNotes, setVerifyNotes] = useState("");
  const [identityChecked, setIdentityChecked] = useState(false);
  const [registrationChecked, setRegistrationChecked] = useState(false);
  const [statusNext, setStatusNext] = useState<"verified" | "suspended" | null>(null);
  const [reason, setReason] = useState("");

  // Plan + credits
  const [billingOpen, setBillingOpen] = useState(false);
  const [plan, setPlan] = useState("free");
  const [creditOverride, setCreditOverride] = useState("");
  const [topUp, setTopUp] = useState("");
  const [billingReason, setBillingReason] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api<CompanyDetail>(`/companies/${id}/detail`);
      setDetail(d);
      setPlan(d.plan);
      setCreditOverride(d.monthlyCreditOverride?.toString() ?? "");
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function verify() {
    setBusy(true);
    setError(null);
    try {
      await api(`/companies/${id}/verify`, {
        method: "POST",
        body: { notes: verifyNotes.trim() || undefined },
      });
      setVerifying(false);
      setVerifyNotes("");
      setNotice(t("admin.verifiedNotice"));
      const pending = await api<{ items: { id: string }[] }>("/companies?status=pending&limit=2&offset=0");
      const next = pending.items.find((company) => company.id !== id);
      const nextQuery = searchParams.get("from") === "operations" ? "from=operations" : `return=${encodeURIComponent(returnQuery ?? "")}`;
      navigate(next ? `/admin/companies/${next.id}?${nextQuery}` : backTo, { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function applyStatus() {
    if (!statusNext) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/companies/${id}/status`, {
        method: "POST",
        body: { status: statusNext, reason },
      });
      setStatusNext(null);
      setReason("");
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveBilling() {
    setBusy(true);
    setError(null);
    try {
      await api(`/admin/companies/${id}/plan`, {
        method: "POST",
        body: {
          plan,
          monthlyCreditOverride: creditOverride === "" ? null : Number(creditOverride),
          reason: billingReason,
        },
      });
      if (topUp !== "" && Number(topUp) > 0) {
        await api(`/admin/companies/${id}/credits`, {
          method: "POST",
          body: { amount: Number(topUp), reason: billingReason },
        });
      }
      setBillingOpen(false);
      setTopUp("");
      setBillingReason("");
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <Stack spacing={2}>
        <Button component={RouterLink} to={backTo} startIcon={<ArrowBackIcon />}>
          {t("admin.backToCompanies")}
        </Button>
        {error ? <Alert severity="error">{error}</Alert> : <Typography>{t("common.loading")}</Typography>}
      </Stack>
    );
  }

  const missing = detail.verification.missing.map((m) =>
    t(`documents.${m}`, { defaultValue: m })
  );

  return (
    <Stack spacing={3}>
      <Button
        component={RouterLink}
        to={backTo}
        startIcon={<ArrowBackIcon />}
        sx={{ alignSelf: "flex-start" }}
      >
        {t("admin.backToCompanies")}
      </Button>

      <PageHeader
        title={detail.legalName}
        subtitle={`DICA ${detail.registrationNumber}`}
        action={
          <Stack direction="row" spacing={1} alignItems="center">
            <StatusChip status={detail.status} />
            {detail.status === "verified" && (
              <Button
                color="error"
                onClick={() => {
                  setStatusNext("suspended");
                  setReason("");
                }}
              >
                {t("admin.deactivate")}
              </Button>
            )}
            {detail.status === "suspended" && (
              <Button
                variant="contained"
                color="success"
                onClick={() => {
                  setStatusNext("verified");
                  setReason("");
                }}
              >
                {t("admin.reactivate")}
              </Button>
            )}
          </Stack>
        }
      />

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {/* --- Verification decision, with the evidence under it --- */}
      <Card>
        <CardContent>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems={{ sm: "center" }}
            spacing={2}
            mb={2}
          >
            <Box>
              <Typography variant="subtitle1">{t("admin.verificationDocuments")}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t("admin.docChecklistHint")}
              </Typography>
            </Box>
            {detail.status === "pending" && (
              <Button
                variant="contained"
                startIcon={<VerifiedIcon />}
                disabled={!detail.verification.ready || busy}
                onClick={() => { setIdentityChecked(false); setRegistrationChecked(false); setVerifying(true); }}
              >
                {t("admin.verify")}
              </Button>
            )}
          </Stack>

          {detail.status === "pending" &&
            (detail.verification.ready ? (
              <Alert severity="success" sx={{ mb: 2 }}>
                {t("admin.readyToVerify")}
              </Alert>
            ) : (
              // Naming what is outstanding is the difference between a button
              // that looks broken and one whose state is self-explanatory.
              <Alert severity="warning" sx={{ mb: 2 }}>
                {t("admin.cannotVerifyYet", { missing: missing.join(", ") })}
              </Alert>
            ))}

          <CompanyDocuments companyId={detail.id} canUpload={false} canReview onReviewed={load} />
        </CardContent>
      </Card>

      {/* --- Record --- */}
      <Card>
        <CardContent>
          <Stack direction="row" spacing={4} flexWrap="wrap" useFlexGap mb={2}>
            <Box>
              <Typography variant="h6">{detail.counts.verifications}</Typography>
              <Typography variant="caption" color="text.secondary">
                {t("admin.tierAChecks")}
              </Typography>
            </Box>
            <Box>
              <Typography variant="h6">{detail.counts.reports}</Typography>
              <Typography variant="caption" color="text.secondary">
                {t("admin.conductReportsCount")}
              </Typography>
            </Box>
            <Box>
              <Typography variant="h6">{detail.creditBalance}</Typography>
              <Typography variant="caption" color="text.secondary">
                {t("common.credits")}
              </Typography>
            </Box>
            <Box>
              <Typography variant="h6" sx={{ textTransform: "capitalize" }}>
                {detail.plan}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("admin.plan")}
              </Typography>
            </Box>
            <Box flex={1} />
            <Button size="small" onClick={() => setBillingOpen(true)}>
              {t("admin.changePlanCredits")}
            </Button>
          </Stack>

          <Typography variant="caption" color="text.secondary">
            {t("admin.registeredOn", { date: formatDateTime(detail.createdAt) })}
            {detail.registrationVerifiedAt &&
              ` · ${t("admin.verifiedOn", { date: formatDateTime(detail.registrationVerifiedAt) })}`}
          </Typography>

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" mb={1}>
            {t("admin.users")}
          </Typography>
          <ScrollableTable minWidth={780}>
            <TableHead>
              <TableRow>
                <TableCell>{t("team.name")}</TableCell>
                <TableCell>{t("admin.nrc")}</TableCell>
                <TableCell>{t("team.email")}</TableCell>
                <TableCell>{t("team.role")}</TableCell>
                <TableCell>{t("common.status")}</TableCell>
                <TableCell>{t("common.created")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {detail.users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.fullName}</TableCell>
                  {/* The number to check the uploaded NRC scan against. */}
                  <TableCell sx={{ fontFamily: "monospace", fontSize: 13 }}>
                    {u.nationalId ?? "—"}
                  </TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{t(`team.roles.${u.role}`, { defaultValue: u.role })}</TableCell>
                  <TableCell>
                    <StatusChip status={u.status} />
                  </TableCell>
                  <TableCell>{formatDateTime(u.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollableTable>

          {detail.subscriptions.length > 0 && (
            <>
              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2" mb={1}>
                {t("admin.subscriptions")}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {detail.subscriptions.map((s) => (
                  <Chip
                    key={s.tier}
                    size="small"
                    variant="outlined"
                    label={`Tier ${s.tier} · ${s.status} · ${formatCalendarDate(s.startDate)}${
                      s.endDate ? ` → ${formatCalendarDate(s.endDate)}` : ""
                    }`}
                  />
                ))}
              </Stack>
            </>
          )}
        </CardContent>
      </Card>

      {/* --- Verify confirmation --- */}
      <Dialog open={verifying} onClose={() => setVerifying(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t("admin.verifyTitle", { company: detail.legalName })}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="info">{t("admin.verifyConsequences")}</Alert>
            <Stack spacing={0.5}>
              <Typography variant="subtitle2">{t("admin.reviewChecklist")}</Typography>
              <FormControlLabel control={<Checkbox checked={detail.verification.ready} disabled />} label={t("admin.checkDocumentsApproved")} />
              <FormControlLabel control={<Checkbox checked={registrationChecked} onChange={(e) => setRegistrationChecked(e.target.checked)} />} label={t("admin.checkRegistrationMatch")} />
              <FormControlLabel control={<Checkbox checked={identityChecked} onChange={(e) => setIdentityChecked(e.target.checked)} />} label={t("admin.checkRepresentativeIdentity")} />
            </Stack>
            <TextField
              label={t("admin.verifyNotes")}
              value={verifyNotes}
              onChange={(e) => setVerifyNotes(e.target.value)}
              fullWidth
              multiline
              minRows={2}
              helperText={t("common.auditNote")}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setVerifying(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="contained" onClick={() => void verify()} disabled={busy || !identityChecked || !registrationChecked}>
            {busy ? t("admin.verifying") : t("admin.verify")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- Suspend / reactivate --- */}
      <Dialog open={statusNext !== null} onClose={() => setStatusNext(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {statusNext === "suspended" ? t("admin.deactivate") : t("admin.reactivate")}{" "}
          {detail.legalName}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity={statusNext === "suspended" ? "warning" : "info"}>
              {statusNext === "suspended"
                ? t("admin.deactivateWarning")
                : t("admin.reactivateInfo")}
            </Alert>
            <TextField
              label={t("common.reason")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              fullWidth
              required
              multiline
              minRows={2}
              helperText={t("admin.reasonAudited")}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setStatusNext(null)}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            color={statusNext === "suspended" ? "error" : "success"}
            disabled={reason.trim().length === 0 || busy}
            onClick={() => void applyStatus()}
          >
            {statusNext === "suspended" ? t("admin.deactivate") : t("admin.reactivate")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- Plan + credits --- */}
      <Dialog open={billingOpen} onClose={() => setBillingOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>
          {t("admin.billingFor")} — {detail.legalName}
          <Typography variant="body2" color="text.secondary">
            {t("admin.balanceCredits", { count: detail.creditBalance })}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              select
              label={t("admin.plan")}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              fullWidth
            >
              {PLANS.map((p) => (
                <MenuItem key={p.key} value={p.key}>
                  {p.label} — {p.fee} · {p.credits}
                </MenuItem>
              ))}
            </TextField>

            {plan === "enterprise" && (
              <TextField
                label={t("admin.monthlyCreditsNegotiated")}
                value={creditOverride}
                onChange={(e) => setCreditOverride(e.target.value.replace(/[^0-9]/g, ""))}
                fullWidth
                helperText={t("admin.enterpriseHint")}
              />
            )}

            <TextField
              label={t("admin.creditTopUp")}
              value={topUp}
              onChange={(e) => setTopUp(e.target.value.replace(/[^0-9]/g, ""))}
              fullWidth
              helperText={t("admin.topUpHint")}
            />

            <TextField
              label={t("common.reason")}
              value={billingReason}
              onChange={(e) => setBillingReason(e.target.value)}
              fullWidth
              required
              helperText={t("common.auditNote")}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setBillingOpen(false)}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            disabled={billingReason.trim().length === 0 || busy}
            onClick={() => void saveBilling()}
          >
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
