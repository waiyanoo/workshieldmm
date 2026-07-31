import { useTranslation } from "react-i18next";
import { useState, type FormEvent } from "react";
import { Link as RouterLink, Navigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ShieldIcon from "@mui/icons-material/Shield";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { brand } from "../theme";

export function LoginPage() {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needsMfa, setNeedsMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password, needsMfa ? mfaCode : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_required") {
        setNeedsMfa(true);
        setError(t("errors.mfa_required"));
      } else {
        setError(apiErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell>
      <form onSubmit={onSubmit}>
        <Stack spacing={2}>
          <Typography variant="h5">{t("auth.signIn")}</Typography>
          {error && <Alert severity={needsMfa ? "info" : "error"}>{error}</Alert>}
          <TextField
            label={t("auth.email")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            fullWidth
          />
          <TextField
            label={t("auth.password")}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            fullWidth
          />
          {needsMfa && (
            <TextField
              label={t("auth.mfaCode")}
              helperText={t("auth.mfaHint")}
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              inputProps={{ inputMode: "numeric", maxLength: 6 }}
              required
              fullWidth
              autoFocus
            />
          )}
          <Button type="submit" variant="contained" size="large" disabled={loading}>
            {loading ? t("auth.signingIn") : t("auth.signIn")}
          </Button>
          <Typography variant="body2" color="text.secondary">
            {t("auth.newEmployer")}{" "}
            <Link component={RouterLink} to="/register">
              {t("auth.registerLink")}
            </Link>
          </Typography>
        </Stack>
      </form>
    </AuthShell>
  );
}

export function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
        background: `radial-gradient(1200px 600px at 15% -10%, ${brand.navyLight} 0%, ${brand.navy} 55%)`,
      }}
    >
      <Card sx={{ width: "100%", maxWidth: 430, borderRadius: 4 }}>
        <CardContent sx={{ p: { xs: 3, sm: 4.5 } }}>
          <Stack direction="row" spacing={1.5} alignItems="center" mb={3}>
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: 2.5,
                display: "grid",
                placeItems: "center",
                background: `linear-gradient(135deg, ${brand.primary}, ${brand.teal})`,
              }}
            >
              <ShieldIcon sx={{ fontSize: 24, color: "#fff" }} />
            </Box>
            <Box>
              <Typography fontWeight={700} fontSize={18} lineHeight={1.2}>
                WorkShield{" "}
                <Box component="span" sx={{ color: brand.primary }}>
                  MM
                </Box>
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("app.tagline")}
              </Typography>
            </Box>
          </Stack>
          {children}
        </CardContent>
      </Card>
    </Box>
  );
}
