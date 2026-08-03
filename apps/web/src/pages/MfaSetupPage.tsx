/**
 * Enrol a second factor.
 *
 * Platform roles cannot work without one, so a newly created reviewer or Super
 * Admin lands here on first sign-in and can reach nothing else until they
 * finish. The secret is generated when this page opens and is never shown to
 * the administrator who created the account — that is the point of doing it
 * here rather than handing over a pre-provisioned code.
 *
 * The QR arrives from the API already rendered, so this works on a machine with
 * no internet access.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { AuthShell } from "./LoginPage";

interface Setup {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

export function MfaSetupPage() {
  const { t } = useTranslation();
  const { user, mustChangePassword, confirmMfa } = useAuth();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!user || mustChangePassword) return;
    void api<Setup>("/auth/mfa/setup", { method: "POST" })
      .then(setSetup)
      .catch((err) => setError(apiErrorMessage(err)));
  }, [user, mustChangePassword]);

  if (!user) return <Navigate to="/login" replace />;
  // The password is the more urgent of the two, so it goes first.
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (done) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmMfa(code);
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
          <Typography variant="h5">{t("mfa.title")}</Typography>
          <Alert severity="info">{t("mfa.why")}</Alert>
          {error && <Alert severity="error">{error}</Alert>}

          <Typography variant="body2" color="text.secondary">
            {t("mfa.step1")}
          </Typography>

          {setup ? (
            <>
              <Box sx={{ textAlign: "center" }}>
                <Box
                  component="img"
                  src={setup.qrDataUrl}
                  alt={t("mfa.qrAlt")}
                  sx={{ width: 220, height: 220, borderRadius: 1.5 }}
                />
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">
                  {t("mfa.cannotScan")}
                </Typography>
                {/* Grouped in fours: this gets typed by hand when a camera
                    will not focus, and an unbroken 16-char string is worse. */}
                <Box
                  sx={{
                    mt: 0.5,
                    p: 1.25,
                    borderRadius: 1.5,
                    bgcolor: "action.hover",
                    fontFamily: "monospace",
                    fontSize: 15,
                    letterSpacing: 1,
                    textAlign: "center",
                  }}
                >
                  {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
                </Box>
              </Box>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t("common.loading")}
            </Typography>
          )}

          <Typography variant="body2" color="text.secondary">
            {t("mfa.step2")}
          </Typography>
          <TextField
            label={t("mfa.code")}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
            inputProps={{ inputMode: "numeric", maxLength: 6 }}
            required
            fullWidth
            autoFocus
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={busy || code.length !== 6 || !setup}
          >
            {busy ? t("mfa.verifying") : t("mfa.submit")}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {t("mfa.keepSafe")}
          </Typography>
        </Stack>
      </form>
    </AuthShell>
  );
}
