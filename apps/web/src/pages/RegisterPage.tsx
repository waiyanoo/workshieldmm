import { useState, type FormEvent } from "react";
import { Link as RouterLink, Navigate } from "react-router-dom";
import { Alert, Button, Divider, Link, Stack, TextField, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/AuthContext";
import { apiErrorMessage } from "../i18n/apiError";
import { AuthShell } from "./LoginPage";
import { EMPTY_NRC, NrcInput, nrcToString, type NrcValue } from "../components/NrcInput";

export function RegisterPage() {
  const { t } = useTranslation();
  const { user, register } = useAuth();
  const [legalName, setLegalName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nrc, setNrc] = useState<NrcValue>(EMPTY_NRC);
  // Composed from the picker, so what reaches the API is already canonical.
  const nationalId = nrcToString(nrc);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register({
        company: { legalName, registrationNumber },
        admin: { fullName, email, password, nationalId },
      });
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <Stack spacing={2}>
          <Typography variant="h5">{t("register.title")}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t("register.pendingMessage")}
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label={t("register.legalName")} value={legalName} onChange={(e) => setLegalName(e.target.value)} required fullWidth />
          <TextField label={t("register.registrationNumber")} value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} required fullWidth />
          <Divider>{t("register.administrator")}</Divider>
          <TextField label={t("register.adminName")} value={fullName} onChange={(e) => setFullName(e.target.value)} required fullWidth />
          <NrcInput value={nrc} onChange={setNrc} required />
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
            {t("register.nrcHint")}
          </Typography>
          <TextField label={t("auth.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required fullWidth />
          <TextField label={t("auth.password")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required fullWidth helperText={t("register.passwordHint")} />
          <Button type="submit" variant="contained" size="large" disabled={loading || !nationalId}>
            {loading ? t("register.creating") : t("register.submit")}
          </Button>
          <Typography variant="body2" color="text.secondary">
            {t("register.haveAccount")} {" "}
            <Link component={RouterLink} to="/login">
              {t("register.signInLink")}
            </Link>
          </Typography>
        </Stack>
      </form>
    </AuthShell>
  );
}
