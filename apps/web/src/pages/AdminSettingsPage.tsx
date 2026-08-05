import { useEffect, useState } from "react";
import { Alert, Button, Card, CardContent, FormControlLabel, Skeleton, Stack, Switch, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { PageHeader } from "../components/ui";
import { refreshFeatures, type Features } from "../hooks/useFeatures";

export function AdminSettingsPage() {
  const { t } = useTranslation();
  const [values, setValues] = useState<Features | null>(null);
  const [saved, setSaved] = useState<Features | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void api<Features>("/admin/settings/features")
      .then((features) => { setValues(features); setSaved(features); })
      .catch((err) => setError(apiErrorMessage(err)));
  }, []);

  async function save() {
    if (!values) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const next = await api<Features>("/admin/settings/features", { method: "PATCH", body: values });
      setValues(next); setSaved(next);
      await refreshFeatures();
      setNotice(t("settings.saved"));
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  }

  const changed = Boolean(values && saved && (values.tierB !== saved.tierB || values.teamInvites !== saved.teamInvites));
  return <Stack spacing={3}>
    <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")} />
    {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
    {notice && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}
    {!values ? <Stack spacing={2}><Skeleton height={130} /><Skeleton height={130} /></Stack> : <>
      <Card><CardContent><Stack spacing={1}>
        <FormControlLabel control={<Switch checked={values.tierB} onChange={(e) => setValues({ ...values, tierB: e.target.checked })} />} label={<Typography fontWeight={700}>{t("settings.tierBTitle")}</Typography>} />
        <Typography variant="body2" color="text.secondary">{t("settings.tierBBody")}</Typography>
        {!values.tierB && <Alert severity="info">{t("settings.tierBOff")}</Alert>}
        {values.tierB && saved && !saved.tierB && <Alert severity="warning">{t("settings.tierBEnableWarning")}</Alert>}
      </Stack></CardContent></Card>
      <Card><CardContent><Stack spacing={1}>
        <FormControlLabel control={<Switch checked={values.teamInvites} onChange={(e) => setValues({ ...values, teamInvites: e.target.checked })} />} label={<Typography fontWeight={700}>{t("settings.teamInvitesTitle")}</Typography>} />
        <Typography variant="body2" color="text.secondary">{t("settings.teamInvitesBody")}</Typography>
        {!values.teamInvites && <Alert severity="info">{t("settings.teamInvitesOff")}</Alert>}
      </Stack></CardContent></Card>
      <Stack direction={{ xs: "column-reverse", sm: "row" }} justifyContent="flex-end" spacing={1}>
        <Button disabled={!changed || busy} onClick={() => saved && setValues(saved)}>{t("common.cancel")}</Button>
        <Button variant="contained" disabled={!changed || busy} onClick={() => void save()}>{busy ? t("common.saving") : t("settings.save")}</Button>
      </Stack>
    </>}
  </Stack>;
}
