import { useState, type FormEvent } from "react";
import { Link as RouterLink, Navigate } from "react-router-dom";
import { Alert, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, Link, Stack, Step, StepLabel, Stepper, TextField, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { DECLARATION_VERSIONS, currentDeclarationText } from "@hyper/shared";
import { useAuth } from "../auth/AuthContext";
import { apiErrorMessage } from "../i18n/apiError";
import { AuthShell } from "./LoginPage";
import { EMPTY_NRC, NrcInput, nrcToString, type NrcValue } from "../components/NrcInput";

export function RegisterPage() {
  const { t, i18n } = useTranslation();
  const { user, register } = useAuth();
  const [legalName, setLegalName] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nrc, setNrc] = useState<NrcValue>(EMPTY_NRC);
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  const [step, setStep] = useState(0);
  const [declarationOpen, setDeclarationOpen] = useState(false);
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
        declaration: { accepted: true, version: DECLARATION_VERSIONS.registration },
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
          <Stepper activeStep={step} alternativeLabel sx={{ mb: 1 }}>
            <Step><StepLabel>{t("register.steps.company")}</StepLabel></Step>
            <Step><StepLabel>{t("register.steps.administrator")}</StepLabel></Step>
            <Step><StepLabel>{t("register.steps.confirm")}</StepLabel></Step>
          </Stepper>

          {step === 0 && <Stack spacing={2}>
            <Typography variant="subtitle1">{t("register.companyStepTitle")}</Typography>
            <TextField label={t("register.legalName")} value={legalName} onChange={(e) => setLegalName(e.target.value)} required fullWidth />
            <TextField label={t("register.registrationNumber")} value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} required fullWidth />
            <Button variant="contained" onClick={() => setStep(1)} disabled={!legalName.trim() || !registrationNumber.trim()}>{t("common.next")}</Button>
          </Stack>}

          {step === 1 && <Stack spacing={2}>
            <Divider>{t("register.administrator")}</Divider>
            <TextField label={t("register.adminName")} value={fullName} onChange={(e) => setFullName(e.target.value)} required fullWidth />
            <NrcInput value={nrc} onChange={setNrc} required />
            <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>{t("register.nrcHint")}</Typography>
            <TextField label={t("auth.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required fullWidth />
            <TextField label={t("auth.password")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required fullWidth helperText={t("register.passwordHint")} />
            <Stack direction="row" spacing={1} justifyContent="space-between"><Button onClick={() => setStep(0)}>{t("common.back")}</Button><Button variant="contained" onClick={() => setStep(2)} disabled={!fullName.trim() || !email.trim() || password.length < 8 || !nationalId}>{t("common.next")}</Button></Stack>
          </Stack>}

          {step === 2 && <Stack spacing={2}>
            <Typography variant="subtitle1">{t("register.confirmStepTitle")}</Typography>
            <Alert severity="info" icon={false}>
              <Typography variant="body2">{legalName}</Typography>
              <Typography variant="body2" color="text.secondary">{registrationNumber} · {email}</Typography>
            </Alert>
            <FormControlLabel
              control={<Checkbox checked={declarationAccepted} onChange={(e) => setDeclarationAccepted(e.target.checked)} />}
              label={<Typography variant="body2">{t("register.declarationShort")}</Typography>}
            />
            <Button variant="text" sx={{ alignSelf: "flex-start" }} onClick={() => setDeclarationOpen(true)}>{t("register.readDeclaration")}</Button>
            <Stack direction="row" spacing={1} justifyContent="space-between"><Button onClick={() => setStep(1)} disabled={loading}>{t("common.back")}</Button><Button type="submit" variant="contained" size="large" disabled={loading || !declarationAccepted}>{loading ? t("register.creating") : t("register.submit")}</Button></Stack>
          </Stack>}
          <Typography variant="body2" color="text.secondary">
            {t("register.haveAccount")} {" "}
            <Link component={RouterLink} to="/login">
              {t("register.signInLink")}
            </Link>
          </Typography>
        </Stack>
      </form>
      <Dialog open={declarationOpen} onClose={() => setDeclarationOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{t("register.declarationTitle")}</DialogTitle>
        <DialogContent dividers><Stack spacing={2}>{/* The wording comes from the shared archive, not the locale files: it
              is the thing being agreed to, and the version recorded against
              this acceptance has to resolve back to exactly these words. */}<Typography variant="body2">{currentDeclarationText("registration", i18n.language)}</Typography><Typography variant="caption" color="text.secondary">{t("register.declarationVersion", { version: DECLARATION_VERSIONS.registration })}</Typography></Stack></DialogContent>
        <DialogActions><Button onClick={() => setDeclarationOpen(false)}>{t("common.close")}</Button></DialogActions>
      </Dialog>
    </AuthShell>
  );
}
