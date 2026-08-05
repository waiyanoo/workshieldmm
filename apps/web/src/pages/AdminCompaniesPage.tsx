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
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControlLabel,
  Skeleton,
  Stack,
  Switch,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TablePagination,
  TextField,
  Typography,
} from "@mui/material";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<Company[]>([]);
  const [pendingOnly, setPendingOnly] = useState(() => searchParams.get("status") === "pending");
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [page, setPage] = useState(() => Math.max(Number(searchParams.get("page")) || 0, 0));
  const [rowsPerPage, setRowsPerPage] = useState(() => [10, 25, 50].includes(Number(searchParams.get("limit"))) ? Number(searchParams.get("limit")) : 25);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  async function load(nextPage = page, nextRows = rowsPerPage, nextQ = q, nextPending = pendingOnly) {
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: nextQ.trim(), limit: String(nextRows), offset: String(nextPage * nextRows) });
      if (nextPending) params.set("status", "pending");
      const res = await api<{ items: Company[]; total: number }>(`/companies?${params}`);
      setItems(res.items);
      setTotal(res.total);
      setPage(nextPage);
      setSearchParams({ ...(nextPending ? { status: "pending" } : {}), ...(nextQ.trim() ? { q: nextQ.trim() } : {}), page: String(nextPage), limit: String(nextRows) }, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("admin.companiesLoadError"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page, rowsPerPage);
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

      <Stack component="form" direction={{ xs: "column", sm: "row" }} spacing={1} onSubmit={(e) => { e.preventDefault(); void load(0); }}>
        <TextField size="small" fullWidth label={t("admin.searchCompanies")} placeholder={t("admin.searchCompaniesPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="contained">{t("common.search")}</Button>
        {(q || pendingOnly) && <Button onClick={() => { setQ(""); setPendingOnly(false); void load(0, rowsPerPage, "", false); }}>{t("common.clearFilters")}</Button>}
      </Stack>
      <Typography variant="body2" color="text.secondary">{t("common.resultCount", { count: total })}{(q || pendingOnly) && ` · ${t("common.filtered")}`}</Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>{pendingOnly && <Chip size="small" label={t("admin.pendingOnly")} onDelete={() => { setPendingOnly(false); void load(0, rowsPerPage, q, false); }} />}{q && <Chip size="small" label={`${t("common.search")}: ${q}`} onDelete={() => { setQ(""); void load(0, rowsPerPage, "", pendingOnly); }} />}</Stack>

      <Card>
        <CardContent>
          {loading ? <Stack spacing={1}>{[1, 2, 3].map((key) => <Skeleton key={key} height={54} />)}</Stack> : items.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t("admin.noCompanies")}
            </Typography>
          ) : (
            <Box sx={{ display: { xs: "none", md: "block" } }}><ScrollableTable minWidth={900}>
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
                        to={`/admin/companies/${c.id}?return=${encodeURIComponent(searchParams.toString())}`}
                      >
                        {/* A pending company needs a decision, so the row says
                            so rather than making the operator infer it. */}
                        {c.status === "pending" ? t("admin.reviewApplication") : t("admin.viewDetails")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable></Box>
          )}
          {!loading && items.length > 0 && <Stack sx={{ display: { xs: "flex", md: "none" } }} spacing={1.5}>{items.map((c) => <Card key={c.id} variant="outlined"><CardContent><Stack spacing={1}><Stack direction="row" justifyContent="space-between" spacing={1}><Typography fontWeight={700}>{c.legalName}</Typography><StatusChip status={c.status} /></Stack><Typography variant="body2" sx={{ fontFamily: "monospace" }}>{c.registrationNumber}</Typography><Typography variant="caption" color="text.secondary">{t("admin.registered")}: {formatDateTime(c.createdAt)} · {c.plan ?? "free"}</Typography><Button component={RouterLink} to={`/admin/companies/${c.id}?return=${encodeURIComponent(searchParams.toString())}`} fullWidth variant={c.status === "pending" ? "contained" : "outlined"}>{c.status === "pending" ? t("admin.reviewApplication") : t("admin.viewDetails")}</Button></Stack></CardContent></Card>)}</Stack>}
          <TablePagination component="div" count={total} page={page} rowsPerPage={rowsPerPage} onPageChange={(_e, value) => void load(value)} onRowsPerPageChange={(e) => { const value = Number(e.target.value); setRowsPerPage(value); void load(0, value); }} rowsPerPageOptions={[10, 25, 50]} labelRowsPerPage={t("admin.rowsPerPage")} />
        </CardContent>
      </Card>
    </Stack>
  );
}
