import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { EmptyState, PageHeader, ScrollableTable } from "../components/ui";

interface AccessRequest {
  id: string;
  requestingCompany: string;
  subjectName: string;
  categoryName: string;
  requestedAt: string;
}

export function AdminAccessRequestsPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<AccessRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await api<{ items: AccessRequest[] }>("/admin/access-requests");
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load access requests");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function decide(id: string, status: "approved" | "denied") {
    setBusyId(id);
    setError(null);
    try {
      await api(`/access-requests/${id}/decision`, { method: "POST", body: { status } });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Decision failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title={t("admin.accessRequestsTitle")}
        subtitle={t("admin.accessRequestsSubtitle")}
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState title={t("admin.noAccessRequests")} />
          ) : (
            <ScrollableTable minWidth={760}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.requestingCompany")}</TableCell>
                  <TableCell>{t("admin.person")}</TableCell>
                  <TableCell>{t("admin.reportCategory")}</TableCell>
                  <TableCell>{t("admin.requestedAt")}</TableCell>
                  <TableCell align="right">{t("admin.decision")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell>{r.requestingCompany}</TableCell>
                    <TableCell>{r.subjectName}</TableCell>
                    <TableCell>{r.categoryName}</TableCell>
                    <TableCell>{new Date(r.requestedAt).toLocaleString()}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        <Button
                          size="small"
                          color="error"
                          disabled={busyId === r.id}
                          onClick={() => decide(r.id, "denied")}
                        >
                          {t("admin.deny")}
                        </Button>
                        <Button
                          size="small"
                          variant="contained"
                          disabled={busyId === r.id}
                          onClick={() => decide(r.id, "approved")}
                        >
                          {t("admin.approve")}
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>
    </>
  );
}
