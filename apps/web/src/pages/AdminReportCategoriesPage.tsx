import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
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
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { EmptyState, PageHeader, ScrollableTable } from "../components/ui";

interface ReportCategory {
  id: string;
  key: string;
  name: string;
  description: string;
  evidenceRequirements: string;
  eligible: boolean;
}

interface FormState {
  id: string | null;
  key: string;
  name: string;
  description: string;
  evidenceRequirements: string;
  eligible: boolean;
  reason: string;
}

function blankForm(): FormState {
  return { id: null, key: "", name: "", description: "", evidenceRequirements: "", eligible: true, reason: "" };
}

export function AdminReportCategoriesPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ReportCategory[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ items: ReportCategory[] }>("/admin/report-categories");
      setItems(result.items);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function edit(category: ReportCategory) {
    setForm({ ...category, id: category.id, evidenceRequirements: category.evidenceRequirements, reason: "" });
  }

  function field(key: keyof FormState, value: string | boolean) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const body = {
        ...(form.id ? {} : { key: form.key.trim() }),
        name: form.name.trim(),
        description: form.description.trim(),
        evidenceRequirements: form.evidenceRequirements.trim(),
        eligible: form.eligible,
        reason: form.reason.trim(),
      };
      if (form.id) await api(`/admin/report-categories/${form.id}`, { method: "PATCH", body });
      else await api("/admin/report-categories", { method: "POST", body });
      setNotice(t(form.id ? "reportCategories.saved" : "reportCategories.created"));
      setForm(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={3}>
      <PageHeader
        title={t("reportCategories.title")}
        subtitle={t("reportCategories.subtitle")}
        action={<Button variant="contained" startIcon={<AddIcon />} onClick={() => setForm(blankForm())}>{t("reportCategories.new")}</Button>}
      />
      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}
      <Card><CardContent>
        {items.length === 0 ? <EmptyState title={t("reportCategories.empty")} /> : (
          <ScrollableTable minWidth={880}>
            <TableHead><TableRow><TableCell>{t("reportCategories.category")}</TableCell><TableCell>{t("reportCategories.evidence")}</TableCell><TableCell>{t("common.status")}</TableCell><TableCell align="right">{t("common.actions")}</TableCell></TableRow></TableHead>
            <TableBody>{items.map((category) => (
              <TableRow key={category.id} hover>
                <TableCell><Typography fontWeight={600}>{category.name}</Typography><Typography variant="caption" color="text.secondary">{category.key}</Typography><Typography variant="body2" color="text.secondary">{category.description}</Typography></TableCell>
                <TableCell sx={{ maxWidth: 320 }}>{category.evidenceRequirements}</TableCell>
                <TableCell><Chip size="small" color={category.eligible ? "success" : "default"} label={t(category.eligible ? "reportCategories.available" : "reportCategories.disabled")} /></TableCell>
                <TableCell align="right"><Button size="small" onClick={() => edit(category)}>{t("common.edit")}</Button></TableCell>
              </TableRow>
            ))}</TableBody>
          </ScrollableTable>
        )}
      </CardContent></Card>
      <Dialog open={form !== null} onClose={() => !busy && setForm(null)} fullWidth maxWidth="md">
        <DialogTitle>{t(form?.id ? "reportCategories.editTitle" : "reportCategories.createTitle")}</DialogTitle>
        <DialogContent dividers><Stack spacing={2} mt={1}>
          {!form?.id && <TextField label={t("reportCategories.key")} value={form?.key ?? ""} onChange={(e) => field("key", e.target.value)} helperText={t("reportCategories.keyHint")} required fullWidth />}
          <TextField label={t("reportCategories.name")} value={form?.name ?? ""} onChange={(e) => field("name", e.target.value)} required fullWidth />
          <TextField label={t("reportCategories.description")} value={form?.description ?? ""} onChange={(e) => field("description", e.target.value)} required fullWidth multiline minRows={2} />
          <TextField label={t("reportCategories.evidenceRequirements")} value={form?.evidenceRequirements ?? ""} onChange={(e) => field("evidenceRequirements", e.target.value)} required fullWidth multiline minRows={2} />
          <TextField select label={t("reportCategories.availability")} value={form?.eligible ? "true" : "false"} onChange={(e) => field("eligible", e.target.value === "true")} fullWidth>
            <MenuItem value="true">{t("reportCategories.available")}</MenuItem><MenuItem value="false">{t("reportCategories.disabled")}</MenuItem>
          </TextField>
          <TextField label={t("reportCategories.changeReason")} value={form?.reason ?? ""} onChange={(e) => field("reason", e.target.value)} helperText={t("reportCategories.changeReasonHint")} required fullWidth multiline minRows={2} />
        </Stack></DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}><Button onClick={() => setForm(null)} disabled={busy}>{t("common.cancel")}</Button><Button variant="contained" onClick={() => void save()} disabled={busy || !form?.name.trim() || !form.description.trim() || !form.evidenceRequirements.trim() || !form.reason.trim() || (!form.id && !form.key.trim())}>{busy ? t("common.saving") : t("common.save")}</Button></DialogActions>
      </Dialog>
    </Stack>
  );
}
