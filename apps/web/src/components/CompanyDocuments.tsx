import { useEffect, useState } from "react";
import {
  Alert,
  Button,
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
import UploadFileIcon from "@mui/icons-material/UploadFile";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import { useTranslation } from "react-i18next";
import { api, uploadFile } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { ScrollableTable, StatusChip } from "./ui";

interface Doc {
  id: string;
  docType: string;
  contentType: string | null;
  byteSize: number | null;
  uploadedAt: string;
  reviewStatus: "pending" | "approved" | "rejected";
  reviewReason: string | null;
  reviewedAt: string | null;
}

export function CompanyDocuments({
  companyId,
  canUpload,
  canReview = false,
  onReviewed,
}: {
  companyId: string;
  canUpload: boolean;
  /** Reviewers and Super Admins get per-document approve / reject controls. */
  canReview?: boolean;
  onReviewed?: () => void;
}) {
  const { t } = useTranslation();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [docType, setDocType] = useState("dica_certificate");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which document is being rejected, and why.
  const [rejecting, setRejecting] = useState<Doc | null>(null);
  const [reason, setReason] = useState("");

  const labelFor = (type: string) => t(`documents.${type}`, { defaultValue: type });
  const uploadOptions = ["dica_certificate", "shop_license", "nrc"];

  async function load() {
    try {
      const res = await api<{ items: Doc[] }>(`/companies/${companyId}/documents`);
      setDocs(res.items);
    } catch {
      // The page can still show the upload controls when the list is unavailable.
    }
  }

  useEffect(() => {
    void load();
  }, [companyId]);

  // Approved only: an uploaded-but-unreviewed file does not satisfy the gate,
  // so showing it as met would contradict what verification then does.
  const approved = new Set(docs.filter((d) => d.reviewStatus === "approved").map((d) => d.docType));
  const hasBusinessDoc = approved.has("dica_certificate") || approved.has("shop_license");
  const hasNrc = approved.has("nrc");

  async function onUpload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("docType", docType);
      fd.append("file", file);
      await uploadFile(`/companies/${companyId}/documents`, fd);
      setFile(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function review(doc: Doc, decision: "approved" | "rejected", why?: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/companies/${companyId}/documents/${doc.id}/review`, {
        method: "POST",
        body: { decision, reason: why },
      });
      setRejecting(null);
      setReason("");
      await load();
      onReviewed?.();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onView(docId: string) {
    try {
      const { url } = await api<{ url: string }>(`/companies/${companyId}/documents/${docId}/download`);
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2}>
        <Requirement met={hasBusinessDoc} label={t("documents.businessRequirement")} />
        <Requirement met={hasNrc} label={t("documents.nrcRequirement")} />
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {canUpload && (
        <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ sm: "center" }}>
          <TextField select label={t("documents.documentType")} value={docType} onChange={(e) => setDocType(e.target.value)} size="small" sx={{ minWidth: 240 }}>
            {uploadOptions.map((type) => <MenuItem key={type} value={type}>{labelFor(type)}</MenuItem>)}
          </TextField>
          <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
            {file ? file.name : t("documents.chooseFile")}
            <input type="file" hidden accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Button>
          <Button variant="contained" onClick={onUpload} disabled={!file || busy}>
            {busy ? t("documents.uploading") : t("documents.upload")}
          </Button>
        </Stack>
      )}
      {docs.length === 0 ? (
        <Typography variant="body2" color="text.secondary">{t("documents.none")}</Typography>
      ) : (
        <ScrollableTable minWidth={620}>
          <TableHead>
            <TableRow>
              <TableCell>{t("documents.documentType")}</TableCell>
              <TableCell>{t("common.status")}</TableCell>
              <TableCell>{t("documents.uploadedAt")}</TableCell>
              <TableCell align="right">{t("common.actions")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {docs.map((d) => (
              <TableRow key={d.id}>
                <TableCell>{labelFor(d.docType)}</TableCell>
                <TableCell>
                  <Stack spacing={0.5}>
                    {/* scope="doc" so an approved document reads "Approved"
                        rather than "Published", which is the report wording. */}
                    <StatusChip status={d.reviewStatus} scope="doc" />
                    {/* The reason is the only thing the company can act on, so
                        it sits with the status rather than behind a click. */}
                    {d.reviewStatus === "rejected" && d.reviewReason && (
                      <Typography variant="caption" color="error.main">
                        {d.reviewReason}
                      </Typography>
                    )}
                  </Stack>
                </TableCell>
                <TableCell>{new Date(d.uploadedAt).toLocaleString()}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button size="small" onClick={() => onView(d.id)}>
                      {t("common.view")}
                    </Button>
                    {canReview && (
                      <>
                        <Button
                          size="small"
                          color="error"
                          disabled={busy}
                          onClick={() => {
                            setRejecting(d);
                            setReason("");
                          }}
                        >
                          {t("documents.reject")}
                        </Button>
                        <Button
                          size="small"
                          variant="contained"
                          disabled={busy || d.reviewStatus === "approved"}
                          onClick={() => review(d, "approved")}
                        >
                          {t("documents.approve")}
                        </Button>
                      </>
                    )}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollableTable>
      )}
      {/* Rejecting needs a reason — it is what the company is asked to fix. */}
      <Dialog open={rejecting !== null} onClose={() => setRejecting(null)} fullWidth maxWidth="xs">
        <DialogTitle>
          {t("documents.rejectTitle", { document: rejecting ? labelFor(rejecting.docType) : "" })}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Alert severity="info">{t("documents.rejectHint")}</Alert>
            <TextField
              label={t("documents.rejectReason")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              fullWidth
              required
              multiline
              minRows={2}
              placeholder={t("documents.rejectPlaceholder")}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setRejecting(null)}>{t("common.cancel")}</Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy || reason.trim().length === 0}
            onClick={() => rejecting && review(rejecting, "rejected", reason.trim())}
          >
            {t("documents.reject")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function Requirement({ met, label }: { met: boolean; label: string }) {
  return <Chip icon={met ? <CheckCircleIcon /> : <RadioButtonUncheckedIcon />} label={label} color={met ? "success" : "default"} variant={met ? "filled" : "outlined"} size="small" />;
}
