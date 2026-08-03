/**
 * Promotional pricing.
 *
 * One screen that changes what every company is charged, so it is built to slow
 * the operator down at the points that matter:
 *
 *   - the promotion in force right now is shown on its own, above the table,
 *     with a worked example of what it does to a real price;
 *   - ending one asks for confirmation and says what happens to prices, not
 *     just "are you sure";
 *   - there is no delete. A promotion that priced a payment is part of the
 *     record behind that payment's receipt.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
import LocalOfferIcon from "@mui/icons-material/LocalOffer";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { EmptyState, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatDateTime } from "../lib/date";
import { brand } from "../theme";

interface Promotion {
  id: string;
  name: string;
  percentOff: number;
  startsAt: string;
  endsAt: string;
  active: boolean;
  createdAt: string;
  state: "scheduled" | "running" | "ended";
  paymentsPriced: number;
  amountMmk: number;
  discountGivenMmk: number;
}

const mmk = (n: number) => `${n.toLocaleString()} MMK`;

/** `datetime-local` wants a local wall-clock string; the API wants ISO UTC. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

interface FormState {
  id: string | null;
  name: string;
  percentOff: string;
  startsAt: string;
  endsAt: string;
}

function blankForm(): FormState {
  const now = new Date();
  const inAMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    id: null,
    name: "",
    percentOff: "20",
    startsAt: toLocalInput(now.toISOString()),
    endsAt: toLocalInput(inAMonth.toISOString()),
  };
}

export function AdminPromotionsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [ending, setEnding] = useState<Promotion | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ items: Promotion[] }>("/admin/promotions");
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = items.find((p) => p.state === "running") ?? null;

  async function save() {
    if (!form) return;
    const percentOff = Number(form.percentOff);
    if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 60) {
      setFormError(t("promotions.percentRange"));
      return;
    }
    if (new Date(form.endsAt) <= new Date(form.startsAt)) {
      setFormError(t("promotions.datesBackwards"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const body = {
        name: form.name.trim(),
        percentOff,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
      };
      if (form.id) {
        // A running promotion keeps the start it actually had; sending it back
        // unchanged is refused by the API, so it is left out.
        const existing = items.find((p) => p.id === form.id);
        const patch =
          existing?.state === "running" ? { ...body, startsAt: undefined } : body;
        await api(`/admin/promotions/${form.id}`, { method: "PATCH", body: patch });
        setNotice(t("promotions.saved"));
      } else {
        await api("/admin/promotions", { method: "POST", body });
        setNotice(t("promotions.created"));
      }
      setForm(null);
      await load();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnd() {
    if (!ending) return;
    setBusy(true);
    try {
      await api(`/admin/promotions/${ending.id}/end`, { method: "POST" });
      setNotice(
        ending.state === "running" ? t("promotions.ended") : t("promotions.cancelled")
      );
      setEnding(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
      setEnding(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title={t("promotions.title")}
        subtitle={t("promotions.subtitle")}
        action={
          <Button
            variant="contained"
            startIcon={<LocalOfferIcon />}
            onClick={() => {
              setForm(blankForm());
              setFormError(null);
            }}
          >
            {t("promotions.new")}
          </Button>
        }
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {/* What is true right now, before the history. */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          {running ? (
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                {t("promotions.liveNow")}
              </Typography>
              <Stack direction="row" spacing={1.5} alignItems="baseline" flexWrap="wrap">
                <Typography variant="h5" sx={{ color: brand.primary, fontWeight: 700 }}>
                  {t("promotions.percentOff", { percent: running.percentOff })}
                </Typography>
                <Typography variant="body1">{running.name}</Typography>
              </Stack>
              <Typography variant="body2" color="text.secondary">
                {t("promotions.until", { date: formatDateTime(running.endsAt) })}
              </Typography>
              {/* A price they will recognise, so the percentage is not abstract. */}
              <Typography variant="body2">
                {t("promotions.example", {
                  list: mmk(49_900),
                  price: mmk(Math.max(50, Math.floor((49_900 * (100 - running.percentOff)) / 100 / 50) * 50)),
                })}
              </Typography>
              {running.paymentsPriced > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t("promotions.sofar", {
                    count: running.paymentsPriced,
                    taken: mmk(running.amountMmk),
                    given: mmk(running.discountGivenMmk),
                  })}
                </Typography>
              )}
            </Stack>
          ) : (
            <Stack spacing={0.5}>
              <Typography variant="overline" color="text.secondary">
                {t("promotions.liveNow")}
              </Typography>
              <Typography variant="body1">{t("promotions.noneRunning")}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t("promotions.noneRunningHint")}
              </Typography>
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          {loading ? (
            <Typography variant="body2" color="text.secondary">
              {t("common.loading")}
            </Typography>
          ) : items.length === 0 ? (
            <EmptyState title={t("promotions.empty")} hint={t("promotions.emptyHint")} />
          ) : (
            <ScrollableTable>
              <TableHead>
                <TableRow>
                  <TableCell>{t("promotions.name")}</TableCell>
                  <TableCell>{t("promotions.discount")}</TableCell>
                  <TableCell>{t("promotions.window")}</TableCell>
                  <TableCell>{t("promotions.status")}</TableCell>
                  <TableCell align="right">{t("promotions.used")}</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.id} hover>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.percentOff}%</TableCell>
                    <TableCell>
                      <Typography variant="body2">{formatDateTime(p.startsAt)}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {t("promotions.to", { date: formatDateTime(p.endsAt) })}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <StatusChip status={p.state} />
                    </TableCell>
                    <TableCell align="right">
                      {p.paymentsPriced > 0 ? (
                        <>
                          <Typography variant="body2">{p.paymentsPriced}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t("promotions.discountGiven", { amount: mmk(p.discountGivenMmk) })}
                          </Typography>
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {p.state !== "ended" && (
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Button
                            size="small"
                            onClick={() => {
                              setForm({
                                id: p.id,
                                name: p.name,
                                percentOff: String(p.percentOff),
                                startsAt: toLocalInput(p.startsAt),
                                endsAt: toLocalInput(p.endsAt),
                              });
                              setFormError(null);
                            }}
                          >
                            {t("common.edit")}
                          </Button>
                          <Button size="small" color="error" onClick={() => setEnding(p)}>
                            {p.state === "running" ? t("promotions.end") : t("common.cancel")}
                          </Button>
                        </Stack>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>

      {/* --- Create / edit ---------------------------------------------------- */}
      <Dialog open={form !== null} onClose={() => setForm(null)} fullWidth maxWidth="sm">
        <DialogTitle>{form?.id ? t("promotions.editTitle") : t("promotions.newTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="info">{t("promotions.scopeNote")}</Alert>
            {formError && <Alert severity="error">{formError}</Alert>}
            <TextField
              label={t("promotions.name")}
              value={form?.name ?? ""}
              onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
              fullWidth
              autoFocus
              helperText={t("promotions.nameHint")}
            />
            <TextField
              label={t("promotions.discount")}
              value={form?.percentOff ?? ""}
              onChange={(e) =>
                setForm((f) =>
                  f ? { ...f, percentOff: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) } : f
                )
              }
              inputProps={{ inputMode: "numeric" }}
              fullWidth
              helperText={t("promotions.percentHint")}
            />
            <TextField
              label={t("promotions.startsAt")}
              type="datetime-local"
              value={form?.startsAt ?? ""}
              onChange={(e) => setForm((f) => (f ? { ...f, startsAt: e.target.value } : f))}
              fullWidth
              InputLabelProps={{ shrink: true }}
              disabled={items.find((p) => p.id === form?.id)?.state === "running"}
              helperText={
                items.find((p) => p.id === form?.id)?.state === "running"
                  ? t("promotions.startLocked")
                  : undefined
              }
            />
            <TextField
              label={t("promotions.endsAt")}
              type="datetime-local"
              value={form?.endsAt ?? ""}
              onChange={(e) => setForm((f) => (f ? { ...f, endsAt: e.target.value } : f))}
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
            {form?.id && <Alert severity="warning">{form && t("promotions.editWarning")}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForm(null)}>{t("common.cancel")}</Button>
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={busy || !form?.name.trim()}
          >
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- End / cancel ----------------------------------------------------- */}
      <Dialog open={ending !== null} onClose={() => setEnding(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {ending?.state === "running" ? t("promotions.endTitle") : t("promotions.cancelTitle")}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {ending?.state === "running"
                ? t("promotions.endBody", { name: ending?.name })
                : t("promotions.cancelBody", { name: ending?.name })}
            </Typography>
            {(ending?.paymentsPriced ?? 0) > 0 && (
              <Alert severity="info">
                {t("promotions.endKeepsPaid", { count: ending?.paymentsPriced })}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEnding(null)}>{t("common.cancel")}</Button>
          <Button color="error" variant="contained" onClick={() => void confirmEnd()} disabled={busy}>
            {ending?.state === "running" ? t("promotions.end") : t("promotions.cancelIt")}
          </Button>
        </DialogActions>
      </Dialog>
      <Box sx={{ height: 8 }} />
    </>
  );
}
