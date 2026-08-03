/**
 * Buy credits by QR. (Pricing Plan §3, §7)
 *
 * Three steps: pick a package, pay the QR putting our reference code in the
 * transfer note, then key in the wallet transaction number. Credits arrive when
 * an admin has matched the payment against the wallet statement — the screen
 * says so plainly, because a buyer who expects instant credits will otherwise
 * think it failed.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CardContent,
  Chip,
  FormControlLabel,
  Switch,
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
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { Trans, useTranslation } from "react-i18next";
import { api, uploadFile, ApiError } from "../api/client";
import { EmptyState, GlassCard, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatCalendarDate } from "../lib/date";
import { brand } from "../theme";

interface Promotion {
  name: string;
  percentOff: number;
  endsAt: string;
}

interface Plan {
  plan: string;
  displayName: string;
  monthlyMmk: number;
  annualMmk: number;
  /** Undiscounted price, for the struck-through figure beside the real one. */
  monthlyListMmk: number;
  annualListMmk: number;
  monthlyCredits: number;
  annualSavingMmk: number;
}

interface CurrentPlan {
  plan: string;
  billingCycle: string;
  endsAt: string;
}

interface Package {
  key: string;
  name: string;
  credits: number;
  priceMmk: number;
  listPriceMmk: number;
  mmkPerCredit: number;
}

interface Method {
  provider: string;
  displayName: string;
  accountName: string;
  accountNumber: string;
  instructions: string | null;
  qrUrl: string | null;
}

interface Intent {
  id: string;
  referenceCode: string;
  credits: number;
  amountMmk: number;
  provider: string;
  status: string;
  expiresAt: string;
  kind?: "credit_pack" | "subscription";
  planName?: string;
  billingCycle?: string;
  monthlyCredits?: number;
}

interface PaymentRow {
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
  decisionNote: string | null;
  createdAt: string;
}

const mmk = (n: number) => `${n.toLocaleString("en-US")} MMK`;

export function BuyCreditsPage() {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentPlan, setCurrentPlan] = useState<CurrentPlan | null>(null);
  const [packages, setPackages] = useState<Package[]>([]);
  const [methods, setMethods] = useState<Method[]>([]);
  const [promotion, setPromotion] = useState<Promotion | null>(null);
  const [annual, setAnnual] = useState(false);
  const [history, setHistory] = useState<PaymentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [intent, setIntent] = useState<Intent | null>(null);
  const [payerReference, setPayerReference] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [opts, mine] = await Promise.all([
        api<{
          plans: Plan[];
          currentPlan: CurrentPlan | null;
          packages: Package[];
          methods: Method[];
          promotion: Promotion | null;
        }>("/payments/options"),
        api<{ items: PaymentRow[] }>("/payments"),
      ]);
      setPlans(opts.plans);
      setCurrentPlan(opts.currentPlan);
      setPackages(opts.packages);
      setMethods(opts.methods);
      setPromotion(opts.promotion);
      setHistory(mine.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load purchase options");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function startPurchase(pkg: Package, provider: string) {
    setError(null);
    setBusy(true);
    try {
      setIntent(await api<Intent>("/payments/intents", {
        method: "POST",
        body: { packageKey: pkg.key, provider },
      }));
      setPayerReference("");
      setProof(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the purchase");
    } finally {
      setBusy(false);
    }
  }

  async function startSubscription(plan: Plan, provider: string) {
    setError(null);
    setBusy(true);
    try {
      setIntent(
        await api<Intent>("/payments/subscriptions", {
          method: "POST",
          body: {
            plan: plan.plan,
            billingCycle: annual ? "annual" : "monthly",
            provider,
          },
        })
      );
      setPayerReference("");
      setProof(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the subscription");
    } finally {
      setBusy(false);
    }
  }

  async function submitProof() {
    if (!intent) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("payerReference", payerReference.trim());
      if (proof) fd.append("proof", proof);
      await uploadFile(`/payments/intents/${intent.id}/proof`, fd);
      setIntent(null);
      setNotice(
        t("billing.submitted")
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit the payment");
    } finally {
      setBusy(false);
    }
  }

  const method = methods.find((m) => m.provider === intent?.provider);

  return (
    <>
      <PageHeader
        title={t("billing.title")}
        subtitle={t("billing.subtitle")}
      />

      {/* Above every price, so nobody reads a figure without knowing it is
          already discounted. */}
      {promotion && (
        <Alert severity="success" icon={false} sx={{ mb: 3 }}>
          <Typography variant="subtitle2">
            {t("billing.promoTitle", { percent: promotion.percentOff })}
          </Typography>
          <Typography variant="body2">
            {t("billing.promoBody", {
              percent: promotion.percentOff,
              date: formatCalendarDate(promotion.endsAt.slice(0, 10)),
            })}
          </Typography>
        </Alert>
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}

      {currentPlan && (
        <Alert severity="success" sx={{ mb: 3 }}>
          <Trans
            i18nKey="billing.currentPlan"
            values={{
              plan: currentPlan.plan,
              cycle: currentPlan.billingCycle,
              date: formatCalendarDate(currentPlan.endsAt),
            }}
          />
        </Alert>
      )}

      {methods.length === 0 ? (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {t("billing.noMethods")}
        </Alert>
      ) : (
        <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", lg: "repeat(12, minmax(0, 1fr))" }, alignItems: "start", gap: 2, mb: 4 }}>
          <GlassCard sx={{ gridColumn: "1 / -1" }}>
            <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
              <Stack direction={{ xs: "column", sm: "row" }} alignItems={{ sm: "center" }} justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
                <Typography variant="subtitle1">{t("billing.monthlyPlans")}</Typography>
                <FormControlLabel control={<Switch checked={annual} onChange={(e) => setAnnual(e.target.checked)} />} label={t("billing.payAnnually")} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t("billing.plansBlurb")}
              </Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 2 }}>
                {plans.map((pl) => (
                  <GlassCard key={pl.plan} sx={{ height: "100%", background: "rgba(255,255,255,0.66)" }}>
                    <CardContent sx={{ height: "100%", display: "flex", flexDirection: "column", p: 2 }}>
                      <Typography variant="h6">{pl.displayName}</Typography>
                      <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" sx={{ mt: 1 }}>
                        <Typography variant="h5" sx={{ color: brand.primary, fontWeight: 700 }}>
                          {mmk(annual ? pl.annualMmk : pl.monthlyMmk)}
                        </Typography>
                        {(annual ? pl.annualListMmk : pl.monthlyListMmk) > (annual ? pl.annualMmk : pl.monthlyMmk) && (
                          <Typography variant="body2" color="text.secondary" sx={{ textDecoration: "line-through" }}>
                            {mmk(annual ? pl.annualListMmk : pl.monthlyListMmk)}
                          </Typography>
                        )}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">{annual ? t("billing.perYear") : t("billing.perMonth")}</Typography>
                      {annual && pl.annualSavingMmk > 0 && <Chip size="small" color="success" label={t("billing.save", { amount: mmk(pl.annualSavingMmk) })} sx={{ alignSelf: "flex-start", mt: 1 }} />}
                      <Typography variant="body2" sx={{ mt: 1.5 }}>{t("billing.creditsEveryMonth", { count: pl.monthlyCredits })}</Typography>
                      <Stack spacing={1} sx={{ mt: "auto", pt: 2 }}>
                        {methods.map((m) => <Button key={m.provider} size="small" variant={m.provider === "kbzpay" ? "contained" : "outlined"} disabled={busy} onClick={() => startSubscription(pl, m.provider)}>{currentPlan?.plan === pl.plan ? t("billing.renewWith", { method: m.displayName }) : t("billing.subscribeWith", { method: m.displayName })}</Button>)}
                      </Stack>
                    </CardContent>
                  </GlassCard>
                ))}
              </Box>
            </CardContent>
          </GlassCard>

          <GlassCard sx={{ gridColumn: "1 / -1" }}>
            <CardContent sx={{ p: { xs: 2, sm: 2.5 } }}>
              <Typography variant="subtitle1">{t("billing.creditPacks")}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                {t("billing.packsBlurb")}
              </Typography>
              <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 1.5 }}>
                {packages.map((p) => (
                  <GlassCard key={p.key} sx={{ background: "rgba(255,255,255,0.66)" }}>
                    <CardContent sx={{ p: 2 }}>
                      <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
                        <Box>
                          <Typography variant="h5" sx={{ color: brand.primary, fontWeight: 700 }}>{p.credits}</Typography>
                          <Typography variant="caption" color="text.secondary">credits</Typography>
                        </Box>
                        <Box textAlign="right">
                          <Typography variant="subtitle1">{mmk(p.priceMmk)}</Typography>
                          {p.listPriceMmk > p.priceMmk && <Typography variant="caption" color="text.secondary" sx={{ textDecoration: "line-through" }}>{mmk(p.listPriceMmk)}</Typography>}
                          <Typography variant="caption" color="text.secondary" display="block">{t("billing.perCredit", { amount: mmk(p.mmkPerCredit) })}</Typography>
                        </Box>
                      </Stack>
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1.5 }}>
                        {methods.map((m) => <Button key={m.provider} size="small" fullWidth variant={m.provider === "kbzpay" ? "contained" : "outlined"} disabled={busy} onClick={() => startPurchase(p, m.provider)}>{t("billing.payWith", { method: m.displayName })}</Button>)}
                      </Stack>
                    </CardContent>
                  </GlassCard>
                ))}
              </Box>
            </CardContent>
          </GlassCard>
        </Box>
      )}

      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {t("billing.history")}
      </Typography>
      <GlassCard>
        <CardContent>
          {history.length === 0 ? (
            <EmptyState title={t("billing.noPurchases")} />
          ) : (
            <ScrollableTable minWidth={720}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("billing.reference")}</TableCell>
                  <TableCell>{t("billing.for")}</TableCell>
                  <TableCell>{t("billing.amount")}</TableCell>
                  <TableCell>{t("billing.method")}</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>{t("billing.date")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id} hover>
                    <TableCell sx={{ fontFamily: "monospace" }}>{h.referenceCode}</TableCell>
                    <TableCell>
                      {h.kind === "subscription"
                        ? t("billing.planPurchase", { plan: h.plan, cycle: h.billingCycle })
                        : t("billing.creditPurchase", { count: h.credits })}
                    </TableCell>
                    <TableCell>{mmk(h.amountMmk)}</TableCell>
                    <TableCell>{h.provider}</TableCell>
                    <TableCell>
                      <Stack spacing={0.5}>
                        <StatusChip status={h.status} />
                        {h.status === "rejected" && h.decisionNote && (
                          <Typography variant="caption" color="error.main">
                            {h.decisionNote}
                          </Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>{new Date(h.createdAt).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </GlassCard>

      {/* Pay + declare */}
      <Dialog open={intent !== null} onClose={() => setIntent(null)} fullWidth maxWidth="sm">
        <DialogTitle>
          {t("billing.pay", { amount: intent ? mmk(intent.amountMmk) : "" })}
          <Typography variant="body2" color="text.secondary">
            {intent?.kind === "subscription"
              ? `${intent.planName} plan · ${intent.billingCycle} · ${intent.monthlyCredits} credits/month`
              : `${intent?.credits} credits`}{" "}
            · {method?.displayName}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          {intent && (
            <Stack spacing={2}>
              {/* The reference code is the whole reconciliation mechanism, so it
                  gets the most visual weight on the screen. */}
              <Alert severity="warning" icon={false}>
                <Typography variant="caption" fontWeight={700} display="block">
                  {t("billing.referenceInstruction").toUpperCase()}
                </Typography>
                <Typography
                  variant="h5"
                  sx={{ fontFamily: "monospace", letterSpacing: 2, fontWeight: 700 }}
                >
                  {intent.referenceCode}
                </Typography>
                <Typography variant="caption">
                  {t("billing.referenceWarning")}
                </Typography>
              </Alert>

              {method?.qrUrl ? (
                <Box sx={{ textAlign: "center" }}>
                  <Box
                    component="img"
                    src={method.qrUrl}
                    alt={`${method.displayName} QR code`}
                    // Scanned off a screen by a phone camera, so it gets as
                    // much room as the dialog allows rather than a thumbnail.
                    sx={{ maxWidth: 340, width: "100%", borderRadius: 2 }}
                  />
                </Box>
              ) : (
                <Alert severity="info">
                  {t("billing.noQr", { method: method?.displayName ?? "" })}
                </Alert>
              )}

              <Stack spacing={0.5}>
                <Typography variant="body2">
                  <b>{method?.accountName}</b>
                </Typography>
                <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                  {method?.accountNumber}
                </Typography>
                <Typography variant="body2">
                  {t("billing.amountLabel")}: <b>{mmk(intent.amountMmk)}</b>
                </Typography>
                {method?.instructions && (
                  <Typography variant="caption" color="text.secondary">
                    {method.instructions}
                  </Typography>
                )}
              </Stack>

              <Divider />

              <Typography variant="subtitle2">{t("billing.afterPaying")}</Typography>
              <TextField
                label={t("billing.txnNumber")}
                value={payerReference}
                onChange={(e) => setPayerReference(e.target.value)}
                fullWidth
                required
                helperText={t("billing.txnHint")}
              />

              <Stack direction="row" spacing={1} alignItems="center">
                <Button component="label" size="small" startIcon={<UploadFileIcon />}>
                  {proof ? t("billing.changeScreenshot") : t("billing.attachScreenshot")}
                  <input
                    type="file"
                    hidden
                    accept="image/jpeg,image/png,application/pdf"
                    onChange={(e) => setProof(e.target.files?.[0] ?? null)}
                  />
                </Button>
                {proof && <Chip size="small" label={proof.name} onDelete={() => setProof(null)} />}
              </Stack>

              <Alert severity="info">
                {t("billing.notAutomatic")}
              </Alert>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setIntent(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={busy || payerReference.trim().length < 3}
            onClick={submitProof}
          >
            {t("billing.iHavePaid")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
