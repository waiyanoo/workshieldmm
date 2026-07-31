/**
 * Companies, as a list.
 *
 * Deliberately only a list. Verification, document review, suspension and
 * billing all moved to /admin/companies/:id — approving a company is a decision
 * taken against its documents, and offering it as a button on a table row
 * encouraged taking it without opening them.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  FormControlLabel,
  Stack,
  Switch,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatDateTime } from "../lib/date";

interface Company {
  id: string;
  legalName: string;
  registrationNumber: string;
  status: string;
  registrationVerifiedAt: string | null;
  createdAt: string;
  plan?: string;
}

export function AdminCompaniesPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Company[]>([]);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const query = pendingOnly ? "?status=pending" : "";
      const res = await api<{ items: Company[] }>(`/companies${query}`);
      setItems(res.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load companies");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOnly]);

  return (
    <Stack spacing={3}>
      <PageHeader
        title={t("admin.companiesTitle")}
        subtitle={t("admin.companiesSubtitle")}
        action={
          <FormControlLabel
            control={
              <Switch checked={pendingOnly} onChange={(e) => setPendingOnly(e.target.checked)} />
            }
            label={t("admin.pendingOnly")}
          />
        }
      />

      {error && <Alert severity="error">{error}</Alert>}

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t("admin.noCompanies")}
            </Typography>
          ) : (
            <ScrollableTable minWidth={900}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.company")}</TableCell>
                  <TableCell>{t("admin.dicaRegNo")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell>{t("admin.plan")}</TableCell>
                  <TableCell>{t("admin.registered")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id} hover>
                    <TableCell>{c.legalName}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>{c.registrationNumber}</TableCell>
                    <TableCell>
                      <StatusChip status={c.status} />
                    </TableCell>
                    <TableCell sx={{ textTransform: "capitalize" }}>{c.plan ?? "free"}</TableCell>
                    <TableCell>{formatDateTime(c.createdAt)}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant={c.status === "pending" ? "contained" : "text"}
                        component={RouterLink}
                        to={`/admin/companies/${c.id}`}
                      >
                        {/* A pending company needs a decision, so the row says
                            so rather than making the operator infer it. */}
                        {c.status === "pending" ? t("admin.reviewApplication") : t("admin.open")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
