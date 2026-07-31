/**
 * Accept a team invitation.
 *
 * Public — the person following this link has no account yet. The company name
 * is shown before the password fields, because "set a password" with no context
 * is indistinguishable from a phishing page, and this link arrives by whatever
 * channel the admin chose to send it.
 *
 * On success it sends them to the normal login screen rather than signing them
 * in. Login is the one path that checks account status and MFA, and accepting
 * an invitation should not be a second way in.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ShieldIcon from "@mui/icons-material/Shield";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { brand } from "../theme";

interface Preview {
  email: string;
  role: string;
  fullName: string | null;
  companyName: string;
  expiresAt: string;
}

export function AcceptInvitePage() {
  const { t } = useTranslation();
  const { token = "" } = useParams();
  const navigate = useNavigate();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Preview>(`/team/invites/${encodeURIComponent(token)}`)
      .then((p) => {
        setPreview(p);
        setFullName(p.fullName ?? "");
      })
      .catch(() => setInvalid(true));
  }, [token]);

  async function submit() {
    if (password !== confirm) {
      setError(t("invite.passwordMismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/team/invites/accept", {
        method: "POST",
        body: { token, fullName: fullName.trim(), password },
      });
      navigate("/login?invited=1");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        p: 2,
        background: `linear-gradient(140deg, ${brand.navy} 0%, ${brand.navyLight} 100%)`,
      }}
    >
      <Card sx={{ width: "100%", maxWidth: 440 }}>
        <CardContent sx={{ p: 4 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Box
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: 2.5,
                  display: "grid",
                  placeItems: "center",
                  background: `linear-gradient(135deg, ${brand.primary}, ${brand.teal})`,
                }}
              >
                <ShieldIcon sx={{ fontSize: 22, color: "#fff" }} />
              </Box>
              <Typography fontWeight={700}>WorkShield MM</Typography>
            </Stack>
            <LanguageSwitcher />
          </Stack>

          {invalid ? (
            <Stack spacing={2}>
              <Alert severity="error">{t("invite.invalid")}</Alert>
              <Typography variant="body2" color="text.secondary">
                {t("invite.invalidHint")}
              </Typography>
              <Button component={RouterLink} to="/login" variant="outlined">
                {t("invite.goToSignIn")}
              </Button>
            </Stack>
          ) : preview === null ? (
            <Typography variant="body2" color="text.secondary">
              {t("common.loading")}
            </Typography>
          ) : (
            <Stack spacing={2.5}>
              <Box>
                <Typography variant="h6">{t("invite.heading")}</Typography>
                <Typography variant="body2" color="text.secondary" mt={0.5}>
                  {t("invite.body", {
                    company: preview.companyName,
                    role: t(`team.roles.${preview.role}`, { defaultValue: preview.role }),
                  })}
                </Typography>
              </Box>

              {/* The address is fixed by the invitation. Showing it read-only
                  prevents the "I signed up with the wrong email" support ticket. */}
              <TextField
                label={t("team.email")}
                value={preview.email}
                fullWidth
                disabled
                helperText={t("invite.emailFixed")}
              />

              {error && <Alert severity="error">{error}</Alert>}

              <TextField
                label={t("invite.yourName")}
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                fullWidth
              />
              <TextField
                label={t("invite.choosePassword")}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                fullWidth
                helperText={t("invite.passwordRule")}
              />
              <TextField
                label={t("invite.confirmPassword")}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                fullWidth
              />

              <Button
                variant="contained"
                size="large"
                onClick={submit}
                disabled={busy || fullName.trim().length === 0 || password.length < 12}
              >
                {t("invite.accept")}
              </Button>
            </Stack>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
