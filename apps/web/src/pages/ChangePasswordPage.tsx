/**
 * Replace your own password.
 *
 * Two ways in. Normally you choose it. But when an administrator has issued a
 * temporary password, the API closes every other route until it is replaced —
 * so ProtectedRoute sends you here and there is no way past. That is deliberate:
 * for as long as the temporary password works, two people know it.
 *
 * The API returns a fresh token pair, which the session is updated with, so
 * changing your password does not sign you out of the tab you are standing in.
 */
import { useState, type FormEvent } from "react";
import { Alert, Button, Stack, TextField, Typography } from "@mui/material";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { apiErrorMessage } from "../i18n/apiError";
import { AuthShell } from "./LoginPage";

export function ChangePasswordPage() {
  const { t } = useTranslation();
  const { user, mustChangePassword, changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) return <Navigate to="/login" replace />;
  if (done) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) {
      setError(t("password.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword(currentPassword, newPassword);
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <Stack spacing={2}>
          <Typography variant="h5">{t("password.title")}</Typography>
          {mustChangePassword ? (
            <Alert severity="warning">{t("password.forced")}</Alert>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t("password.subtitle")}
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label={mustChangePassword ? t("password.temporary") : t("password.current")}
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            fullWidth
            autoFocus
          />
          <TextField
            label={t("password.new")}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            fullWidth
            helperText={t("password.rule")}
          />
          <TextField
            label={t("password.confirm")}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            fullWidth
          />
          <Typography variant="caption" color="text.secondary">
            {t("password.sessionsNote")}
          </Typography>
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={busy || newPassword.length < 8}
          >
            {busy ? t("password.saving") : t("password.submit")}
          </Button>
        </Stack>
      </form>
    </AuthShell>
  );
}
