/**
 * Company team management.
 *
 * The page is readable by everyone in the company and editable only by admins,
 * which is deliberate: knowing who else can see your candidates' NRCs is not
 * privileged information within an organisation, and hiding the list makes it
 * harder to notice an account that should have been closed months ago.
 *
 * The invitation link is shown once, in a dialog, with a copy button. There is
 * no email transport yet, so the admin sends it themselves — an honest "here is
 * the link, send it to them" beats a "we've emailed them" that never arrives.
 */
import { useEffect, useState } from "react";
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
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import KeyOffIcon from "@mui/icons-material/KeyOff";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import HistoryIcon from "@mui/icons-material/History";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { EmptyState, PageHeader, ScrollableTable, StatusChip } from "../components/ui";
import { formatDateTime } from "../lib/date";

interface Member {
  id: string;
  fullName: string;
  email: string;
  role: string;
  status: string;
  mfaEnabled: boolean;
  createdAt: string;
  checks: number;
  reports: number;
  lastActivity: string | null;
  isSelf: boolean;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  fullName: string | null;
  expiresAt: string;
  createdAt: string;
  invitedByName: string | null;
  expired: boolean;
}

interface TeamResponse {
  canManage: boolean;
  /** Whether this deployment has team invitations switched on at all. */
  invitesEnabled: boolean;
  members: Member[];
  invites: Invite[];
}

interface Activity {
  member: { fullName: string };
  checks: { id: string; subjectName: string; status: string; createdAt: string }[];
  reports: { id: string; subjectName: string; categoryName: string; status: string; createdAt: string }[];
}

export function TeamPage() {
  const { t } = useTranslation();
  const [team, setTeam] = useState<TeamResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Invite form
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("company_user");
  const [issued, setIssued] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Activity drawer
  const [activity, setActivity] = useState<Activity | null>(null);

  async function load() {
    try {
      setTeam(await api<TeamResponse>("/team"));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function sendInvite() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ email: string; token: string }>("/team/invites", {
        method: "POST",
        body: { email: email.trim(), role, fullName: fullName.trim() || undefined },
      });
      setInviteOpen(false);
      setEmail("");
      setFullName("");
      setRole("company_user");
      setCopied(false);
      // Built from the current origin so it works in dev, staging and
      // production without a configured base URL to get out of step.
      setIssued({ email: res.email, link: `${window.location.origin}/invite/${res.token}` });
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const canManage = team?.canManage ?? false;
  // Invitations are behind a deployment flag while there is no email transport
  // to send them. With it off the controls are absent rather than disabled —
  // a greyed-out button invites a support ticket asking how to enable it.
  const canInvite = canManage && (team?.invitesEnabled ?? false);

  return (
    <Stack spacing={3}>
      <PageHeader
        title={t("team.title")}
        subtitle={t("team.subtitle")}
        action={
          canInvite && (
            <Button
              variant="contained"
              startIcon={<PersonAddIcon />}
              onClick={() => setInviteOpen(true)}
            >
              {t("team.invite")}
            </Button>
          )
        }
      />

      {error && <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice(null)}>{notice}</Alert>}

      <Card>
        <CardContent>
          <Typography variant="subtitle2" mb={1.5}>
            {t("team.members")}
          </Typography>
          <ScrollableTable minWidth={900}>
            <TableHead>
              <TableRow>
                <TableCell>{t("team.name")}</TableCell>
                <TableCell>{t("team.role")}</TableCell>
                <TableCell>{t("common.status")}</TableCell>
                <TableCell align="right">{t("team.checksRun")}</TableCell>
                <TableCell align="right">{t("team.reportsFiled")}</TableCell>
                <TableCell>{t("team.lastActivity")}</TableCell>
                <TableCell align="right">{t("common.actions")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(team?.members ?? []).map((m) => (
                <TableRow key={m.id} sx={{ opacity: m.status === "active" ? 1 : 0.6 }}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {m.fullName}
                      {m.isSelf && (
                        <Typography component="span" variant="caption" color="text.secondary">
                          {" "}
                          {t("team.you")}
                        </Typography>
                      )}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {m.email}
                      {/* Whether a colleague has a second factor is the kind of
                          thing an admin should be able to see without asking. */}
                      {m.mfaEnabled ? ` · ${t("team.mfaOn")}` : ` · ${t("team.mfaOff")}`}
                    </Typography>
                  </TableCell>
                  <TableCell>{t(`team.roles.${m.role}`, { defaultValue: m.role })}</TableCell>
                  <TableCell>
                    <StatusChip status={m.status} />
                  </TableCell>
                  <TableCell align="right">{m.checks}</TableCell>
                  <TableCell align="right">{m.reports}</TableCell>
                  <TableCell>
                    {m.lastActivity ? formatDateTime(m.lastActivity) : t("common.none")}
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      {canManage && (
                        <Tooltip title={t("team.viewActivity")}>
                          <IconButton
                            size="small"
                            onClick={() =>
                              void api<Activity>(`/team/members/${m.id}/activity`)
                                .then(setActivity)
                                .catch((err) => setError(apiErrorMessage(err)))
                            }
                          >
                            <HistoryIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}
                      {canManage && !m.isSelf && (
                        <>
                          <Tooltip title={t("team.resetMfa")}>
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy || !m.mfaEnabled}
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/team/members/${m.id}/reset-mfa`, { method: "POST" }),
                                    t("team.mfaResetDone", { name: m.fullName })
                                  )
                                }
                              >
                                <KeyOffIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip
                            title={
                              m.status === "active" ? t("team.deactivate") : t("team.reactivate")
                            }
                          >
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy}
                                color={m.status === "active" ? "error" : "success"}
                                onClick={() =>
                                  void act(
                                    () =>
                                      api(`/team/members/${m.id}`, {
                                        method: "PATCH",
                                        body: {
                                          status:
                                            m.status === "active" ? "suspended" : "active",
                                        },
                                      }),
                                    m.status === "active"
                                      ? t("team.deactivated", { name: m.fullName })
                                      : t("team.reactivated", { name: m.fullName })
                                  )
                                }
                              >
                                {m.status === "active" ? (
                                  <BlockIcon fontSize="small" />
                                ) : (
                                  <CheckCircleIcon fontSize="small" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                        </>
                      )}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollableTable>

          {canManage && (
            <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
              {t("team.deactivateNote")}
            </Typography>
          )}
        </CardContent>
      </Card>

      {(team?.invites.length ?? 0) > 0 && (
        <Card>
          <CardContent>
            <Typography variant="subtitle2" mb={1.5}>
              {t("team.pendingInvites")}
            </Typography>
            <ScrollableTable minWidth={640}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("team.email")}</TableCell>
                  <TableCell>{t("team.role")}</TableCell>
                  <TableCell>{t("team.invitedBy")}</TableCell>
                  <TableCell>{t("common.expires")}</TableCell>
                  <TableCell align="right">{t("common.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {team!.invites.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{i.email}</TableCell>
                    <TableCell>{t(`team.roles.${i.role}`, { defaultValue: i.role })}</TableCell>
                    <TableCell>{i.invitedByName ?? "—"}</TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        color={i.expired ? "error.main" : "text.primary"}
                      >
                        {i.expired ? t("team.inviteExpired") : formatDateTime(i.expiresAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {canManage && (
                        <Button
                          size="small"
                          color="error"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              () => api(`/team/invites/${i.id}/revoke`, { method: "POST" }),
                              t("team.inviteRevoked", { email: i.email })
                            )
                          }
                        >
                          {t("team.revoke")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          </CardContent>
        </Card>
      )}

      {/* --- Invite dialog --- */}
      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t("team.inviteTitle")}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <TextField
              label={t("team.email")}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              fullWidth
              autoFocus
            />
            <TextField
              label={t("team.nameOptional")}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              fullWidth
            />
            <TextField
              select
              label={t("team.role")}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              fullWidth
              helperText={
                role === "company_admin" ? t("team.roleAdminHelp") : t("team.roleUserHelp")
              }
            >
              <MenuItem value="company_user">{t("team.roles.company_user")}</MenuItem>
              <MenuItem value="company_admin">{t("team.roles.company_admin")}</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setInviteOpen(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="contained" onClick={sendInvite} disabled={busy || !email.trim()}>
            {t("team.createInvite")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- The link, shown once --- */}
      <Dialog open={issued !== null} onClose={() => setIssued(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t("team.inviteReady")}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Alert severity="info">{t("team.inviteLinkOnce", { email: issued?.email })}</Alert>
            <Box
              sx={{
                p: 1.5,
                borderRadius: 1.5,
                bgcolor: "action.hover",
                fontFamily: "monospace",
                fontSize: 13,
                wordBreak: "break-all",
              }}
            >
              {issued?.link}
            </Box>
            <Button
              startIcon={<ContentCopyIcon />}
              variant="outlined"
              onClick={() => {
                void navigator.clipboard.writeText(issued?.link ?? "");
                setCopied(true);
              }}
            >
              {copied ? t("team.copied") : t("team.copyLink")}
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="contained" onClick={() => setIssued(null)}>
            {t("common.close")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- One person's activity --- */}
      <Dialog open={activity !== null} onClose={() => setActivity(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t("team.activityOf", { name: activity?.member.fullName })}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} mt={1}>
            <Typography variant="subtitle2">{t("team.checksRun")}</Typography>
            {activity?.checks.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("team.noChecks")}
              </Typography>
            ) : (
              activity?.checks.map((c) => (
                <Stack key={c.id} direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" flex={1}>
                    {c.subjectName}
                  </Typography>
                  <StatusChip status={c.status} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDateTime(c.createdAt)}
                  </Typography>
                </Stack>
              ))
            )}

            <Divider />
            <Typography variant="subtitle2">{t("team.reportsFiled")}</Typography>
            {activity?.reports.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("team.noReports")}
              </Typography>
            ) : (
              activity?.reports.map((r) => (
                <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                  <Typography variant="body2" flex={1}>
                    {r.subjectName} · {r.categoryName}
                  </Typography>
                  <StatusChip status={r.status} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDateTime(r.createdAt)}
                  </Typography>
                </Stack>
              ))
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setActivity(null)}>{t("common.close")}</Button>
        </DialogActions>
      </Dialog>

      {team && team.members.length === 0 && (
        <EmptyState title={t("team.noMembers")} />
      )}
    </Stack>
  );
}
