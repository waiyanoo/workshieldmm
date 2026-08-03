/**
 * Account administration.
 *
 * Two populations, two tabs: platform staff and company logins. The controls
 * look mundane and are not — resetting a password or moving a login email is
 * the power to become another person — so the screen is built to make that
 * visible rather than smooth:
 *
 *   - No password field anywhere. The system issues a temporary password and
 *     shows it once, in a dialog you have to dismiss deliberately.
 *   - Actions on yourself are absent, not disabled, so there is nothing to
 *     click by accident on your own row.
 *   - Every dialog says plainly what will happen to the person's live sessions.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TablePagination,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import KeyIcon from "@mui/icons-material/VpnKey";
import KeyOffIcon from "@mui/icons-material/KeyOff";
import EditIcon from "@mui/icons-material/Edit";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { EmptyState, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatDateTime } from "../lib/date";

interface PlatformAccount {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  createdByName: string | null;
  decisions: number;
  lastLogin: string | null;
  isSelf: boolean;
}

interface CompanyAccount {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  companyId: string;
  companyName: string;
  companyStatus: string;
}

const PLATFORM_ROLES = ["super_admin", "admin_reviewer", "review_board"];

/** The one-time password, shown once and never retrievable. */
function IssuedPasswordDialog({
  issued,
  onClose,
}: {
  issued: { email: string; temporaryPassword: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  if (!issued) return null;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t("accounts.tempTitle")}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} mt={1}>
          <Alert severity="warning">{t("accounts.tempOnce", { email: issued.email })}</Alert>
          <Box
            sx={{
              p: 2,
              borderRadius: 1.5,
              bgcolor: "action.hover",
              fontFamily: "monospace",
              fontSize: 22,
              letterSpacing: 1,
              textAlign: "center",
            }}
          >
            {issued.temporaryPassword}
          </Box>
          <Button
            startIcon={<ContentCopyIcon />}
            variant="outlined"
            onClick={() => {
              void navigator.clipboard.writeText(issued.temporaryPassword);
              setCopied(true);
            }}
          >
            {copied ? t("team.copied") : t("accounts.copyPassword")}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {t("accounts.tempExplain")}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose}>
          {t("accounts.savedIt")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AdminAccountsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState(0);
  const [platform, setPlatform] = useState<PlatformAccount[]>([]);
  const [company, setCompany] = useState<CompanyAccount[]>([]);
  const [q, setQ] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const rowsPerPage = 25;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [issued, setIssued] = useState<{ email: string; temporaryPassword: string } | null>(null);

  // Create staff
  const [createOpen, setCreateOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("admin_reviewer");

  // Edit (either population)
  const [editing, setEditing] = useState<
    | { kind: "platform"; row: PlatformAccount }
    | { kind: "company"; row: CompanyAccount }
    | null
  >(null);
  const [editEmail, setEditEmail] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editStatus, setEditStatus] = useState("active");

  // Confirm a reset before it happens.
  const [resetting, setResetting] = useState<
    { kind: "platform" | "company"; id: string; label: string } | null
  >(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({
        limit: String(rowsPerPage),
        offset: String(page * rowsPerPage),
      });
      if (q.trim()) params.set("q", q.trim());
      if (tab === 0) {
        const res = await api<{ items: PlatformAccount[]; total: number }>(
          `/admin/accounts?${params}`
        );
        setPlatform(res.items);
        setTotal(res.total);
      } else {
        const res = await api<{ items: CompanyAccount[]; total: number }>(
          `/admin/company-accounts?${params}`
        );
        setCompany(res.items);
        setTotal(res.total);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [tab, q, page]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  async function act(fn: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (message) setNotice(message);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ email: string; temporaryPassword: string }>("/admin/accounts", {
        method: "POST",
        body: { fullName: fullName.trim(), email: email.trim(), role },
      });
      setCreateOpen(false);
      setFullName("");
      setEmail("");
      setRole("admin_reviewer");
      setIssued(res);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function openEdit(
    target: { kind: "platform"; row: PlatformAccount } | { kind: "company"; row: CompanyAccount }
  ) {
    setEditing(target);
    setEditEmail(target.row.email);
    setEditStatus(target.row.status);
    setEditRole(target.kind === "platform" ? target.row.role : "");
  }

  async function saveEdit() {
    if (!editing) return;
    const path =
      editing.kind === "platform"
        ? `/admin/accounts/${editing.row.id}`
        : `/admin/company-accounts/${editing.row.id}`;
    const body: Record<string, unknown> = { status: editStatus };
    if (editEmail.trim().toLowerCase() !== editing.row.email.toLowerCase()) {
      body.email = editEmail.trim();
    }
    if (editing.kind === "platform" && editRole !== editing.row.role) body.role = editRole;

    await act(async () => {
      await api(path, { method: "PATCH", body });
      setEditing(null);
    }, t("accounts.saved"));
  }

  async function doReset() {
    if (!resetting) return;
    const path =
      resetting.kind === "platform"
        ? `/admin/accounts/${resetting.id}/reset-password`
        : `/admin/company-accounts/${resetting.id}/reset-password`;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ email: string; temporaryPassword: string }>(path, { method: "POST" });
      setResetting(null);
      setIssued(res);
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
        title={t("accounts.title")}
        subtitle={t("accounts.subtitle")}
        action={
          tab === 0 && (
            <Button
              variant="contained"
              startIcon={<PersonAddIcon />}
              onClick={() => setCreateOpen(true)}
            >
              {t("accounts.addStaff")}
            </Button>
          )
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

      <Card>
        <CardContent>
          <Tabs
            value={tab}
            onChange={(_, v) => {
              setTab(v);
              setPage(0);
              setQ("");
            }}
            sx={{ mb: 2 }}
          >
            <Tab label={t("accounts.platformTab")} />
            <Tab label={t("accounts.companyTab")} />
          </Tabs>

          <TextField
            size="small"
            label={tab === 0 ? t("accounts.searchStaff") : t("accounts.searchCompany")}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
            sx={{ mb: 2, minWidth: 340 }}
          />

          {tab === 0 ? (
            <ScrollableTable minWidth={980}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("team.name")}</TableCell>
                  <TableCell>{t("team.role")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                  <TableCell align="right">{t("accounts.decisions")}</TableCell>
                  <TableCell>{t("accounts.lastLogin")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {platform.map((u) => (
                  <TableRow key={u.id} sx={{ opacity: u.status === "active" ? 1 : 0.6 }}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {u.fullName}
                        {u.isSelf && (
                          <Typography component="span" variant="caption" color="text.secondary">
                            {" "}
                            {t("team.you")}
                          </Typography>
                        )}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {u.email}
                        {u.mfaEnabled ? ` · ${t("team.mfaOn")}` : ` · ${t("team.mfaOff")}`}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {t(`accounts.roles.${u.role}`, { defaultValue: u.role })}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <StatusChip status={u.status} />
                        {u.mustChangePassword && (
                          <Tooltip title={t("accounts.awaitingChange")}>
                            <Chip size="small" color="warning" label={t("accounts.tempChip")} />
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{u.decisions}</TableCell>
                    <TableCell>
                      {u.lastLogin ? formatDateTime(u.lastLogin) : t("common.none")}
                    </TableCell>
                    <TableCell align="right">
                      {/* Absent on your own row rather than disabled — there is
                          nothing here you should be doing to yourself. */}
                      {!u.isSelf && (
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <Tooltip title={t("accounts.edit")}>
                            <IconButton size="small" onClick={() => openEdit({ kind: "platform", row: u })}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={t("accounts.resetPassword")}>
                            <IconButton
                              size="small"
                              disabled={busy}
                              onClick={() =>
                                setResetting({ kind: "platform", id: u.id, label: u.email })
                              }
                            >
                              <KeyIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={t("accounts.resetMfa")}>
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy || !u.mfaEnabled}
                                onClick={() =>
                                  void act(
                                    () => api(`/admin/accounts/${u.id}/reset-mfa`, { method: "POST" }),
                                    t("accounts.mfaReset", { email: u.email })
                                  )
                                }
                              >
                                <KeyOffIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          ) : (
            <>
              {company.length === 0 ? (
                <EmptyState title={t("accounts.noCompanyAccounts")} />
              ) : (
                <ScrollableTable minWidth={980}>
                  <TableHead>
                    <TableRow>
                      <TableCell>{t("team.name")}</TableCell>
                      <TableCell>{t("admin.company")}</TableCell>
                      <TableCell>{t("team.role")}</TableCell>
                      <TableCell>{t("common.status")}</TableCell>
                      <TableCell align="right">{t("common.actions")}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {company.map((u) => (
                      <TableRow key={u.id} sx={{ opacity: u.status === "active" ? 1 : 0.6 }}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>
                            {u.fullName}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {u.email}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">{u.companyName}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t(`status.${u.companyStatus}`, { defaultValue: u.companyStatus })}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {t(`team.roles.${u.role}`, { defaultValue: u.role })}
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <StatusChip status={u.status} />
                            {u.mustChangePassword && (
                              <Tooltip title={t("accounts.awaitingChange")}>
                                <Chip size="small" color="warning" label={t("accounts.tempChip")} />
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <Tooltip title={t("accounts.edit")}>
                              <IconButton size="small" onClick={() => openEdit({ kind: "company", row: u })}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={t("accounts.resetPassword")}>
                              <IconButton
                                size="small"
                                disabled={busy}
                                onClick={() =>
                                  setResetting({ kind: "company", id: u.id, label: u.email })
                                }
                              >
                                <KeyIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title={t("accounts.resetMfa")}>
                              <span>
                                <IconButton
                                  size="small"
                                  disabled={busy || !u.mfaEnabled}
                                  onClick={() =>
                                    void act(
                                      () =>
                                        api(`/admin/company-accounts/${u.id}/reset-mfa`, {
                                          method: "POST",
                                        }),
                                      t("accounts.mfaReset", { email: u.email })
                                    )
                                  }
                                >
                                  <KeyOffIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </ScrollableTable>
              )}
            </>
          )}

          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={(_, p) => setPage(p)}
            rowsPerPage={rowsPerPage}
            rowsPerPageOptions={[rowsPerPage]}
          />
        </CardContent>
      </Card>

      {/* --- Create staff --- */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t("accounts.addStaff")}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="info">{t("accounts.createNote")}</Alert>
            <TextField
              label={t("team.name")}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              fullWidth
              autoFocus
            />
            <TextField
              label={t("team.email")}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              fullWidth
            />
            <TextField
              select
              label={t("team.role")}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              fullWidth
            >
              {PLATFORM_ROLES.map((r) => (
                <MenuItem key={r} value={r}>
                  {t(`accounts.roles.${r}`, { defaultValue: r })}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCreateOpen(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={busy || !fullName.trim() || !email.trim()}
            onClick={() => void createAccount()}
          >
            {t("accounts.create")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- Edit --- */}
      <Dialog open={editing !== null} onClose={() => setEditing(null)} fullWidth maxWidth="xs">
        <DialogTitle>{editing?.row.fullName}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              label={t("accounts.loginEmail")}
              type="email"
              value={editEmail}
              onChange={(e) => setEditEmail(e.target.value)}
              fullWidth
              helperText={t("accounts.emailWarning")}
            />
            {editing?.kind === "platform" && (
              <TextField
                select
                label={t("team.role")}
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                fullWidth
              >
                {PLATFORM_ROLES.map((r) => (
                  <MenuItem key={r} value={r}>
                    {t(`accounts.roles.${r}`, { defaultValue: r })}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              select
              label={t("common.status")}
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              fullWidth
              helperText={
                editStatus === "suspended" ? t("accounts.suspendWarning") : undefined
              }
            >
              <MenuItem value="active">{t("status.active")}</MenuItem>
              <MenuItem value="suspended">{t("status.suspended")}</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setEditing(null)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="contained" disabled={busy} onClick={() => void saveEdit()}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- Confirm reset --- */}
      <Dialog open={resetting !== null} onClose={() => setResetting(null)} fullWidth maxWidth="xs">
        <DialogTitle>{t("accounts.resetTitle")}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="warning">
              {t("accounts.resetWarning", { email: resetting?.label })}
            </Alert>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setResetting(null)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={busy}
            onClick={() => void doReset()}
          >
            {t("accounts.resetConfirm")}
          </Button>
        </DialogActions>
      </Dialog>

      <IssuedPasswordDialog issued={issued} onClose={() => setIssued(null)} />
    </Stack>
  );
}
