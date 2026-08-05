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
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
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
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: { xs: 2, sm: 3 },
        background: [
          "radial-gradient(circle at 12% 15%, rgba(47,107,255,0.32), transparent 32%)",
          "radial-gradient(circle at 88% 82%, rgba(15,164,138,0.22), transparent 30%)",
          `linear-gradient(135deg, ${brand.navyLight} 0%, ${brand.navy} 52%, #071426 100%)`,
        ].join(", "),
        "&::before": {
          content: '""',
          position: "absolute",
          inset: 0,
          opacity: 0.16,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.12) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "linear-gradient(to bottom right, #000, transparent 72%)",
        },
        "&::after": {
          content: '""',
          position: "absolute",
          width: { xs: 260, md: 420 },
          height: { xs: 260, md: 420 },
          right: { xs: -150, md: -110 },
          top: { xs: -150, md: -120 },
          border: "1px solid rgba(255,255,255,0.13)",
          borderRadius: "50%",
          boxShadow: "0 0 0 54px rgba(255,255,255,0.025), 0 0 0 108px rgba(255,255,255,0.02)",
        },
      }}
    >
      <Box
        sx={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 980,
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "minmax(0, 1fr) 430px" },
          alignItems: "center",
          gap: { md: 7 },
        }}
      >
        <Box sx={{ display: { xs: "none", md: "block" }, color: "#fff", pl: 2 }}>
          <Box
            sx={{
              width: 72,
              height: 72,
              mb: 3,
              borderRadius: 4,
              display: "grid",
              placeItems: "center",
              background: "linear-gradient(135deg, rgba(47,107,255,0.95), rgba(15,164,138,0.9))",
              boxShadow: "0 20px 50px rgba(0,0,0,0.28)",
              transform: "rotate(-4deg)",
            }}
          >
            <ShieldIcon sx={{ fontSize: 40, color: "#fff", transform: "rotate(4deg)" }} />
          </Box>
          <Typography variant="h3" fontWeight={750} maxWidth={470} lineHeight={1.12} letterSpacing="-0.035em">
            {t("auth.securityTitle")}
          </Typography>
          <Typography sx={{ mt: 2, mb: 4, maxWidth: 480, color: "rgba(255,255,255,0.68)", fontSize: 17, lineHeight: 1.7 }}>
            {t("auth.securitySubtitle")}
          </Typography>
          <Stack spacing={2}>
            {[
              [<FactCheckOutlinedIcon key="check" />, t("auth.securityBenefitVerification")],
              [<LockOutlinedIcon key="lock" />, t("auth.securityBenefitPrivacy")],
              [<CheckCircleOutlineIcon key="audit" />, t("auth.securityBenefitAudit")],
            ].map(([icon, label]) => (
              <Stack key={String(label)} direction="row" spacing={1.5} alignItems="center">
                <Box sx={{ width: 36, height: 36, borderRadius: 2, display: "grid", placeItems: "center", bgcolor: "rgba(255,255,255,0.09)", color: "#8FDACD" }}>
                  {icon}
                </Box>
                <Typography fontWeight={600} color="rgba(255,255,255,0.88)">{label}</Typography>
              </Stack>
            ))}
          </Stack>
        </Box>

      <Card
        sx={{
          width: "100%",
          maxWidth: 430,
          mx: "auto",
          borderRadius: 4,
          borderColor: "rgba(255,255,255,0.45)",
          boxShadow: "0 28px 80px rgba(0,0,0,0.32)",
        }}
      >
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
    </Box>
  );
}
