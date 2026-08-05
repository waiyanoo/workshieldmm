/**
 * Credit balance for the signed-in company. (Pricing Plan §3, §4)
 *
 * Shows what actions cost and what is about to lapse. Credits have different
 * lifetimes depending on where they came from, so the screen names the source
 * of whatever expires next — otherwise a drop in the balance looks arbitrary.
 */
import { useEffect, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { alpha } from "@mui/material/styles";
import { Link as RouterLink } from "react-router-dom";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { brand } from "../theme";

interface CreditSummary {
  balance: number;
  costs: Record<string, number>;
  expiring: { remaining: number; expiresAt: string; reason: string }[];
  recent: { delta: number; action: string; resourceType: string | null; createdAt: string }[];
}

export function CreditBalance({
  glass = false,
  compact = false,
}: {
  glass?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setSummary(await api<CreditSummary>("/credits"));
      } catch (err) {
        setError(apiErrorMessage(err));
      }
    })();
  }, []);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!summary) return null;

  // Anything lapsing within 30 days is worth warning about while it can still
  // be spent.
  const soon = summary.expiring.filter(
    (e) => new Date(e.expiresAt).getTime() - Date.now() < 30 * 24 * 3600 * 1000
  );
  const expiringSoon = soon.reduce((sum, e) => sum + e.remaining, 0);

  return (
    <Card
      sx={
        glass
          ? {
              height: "100%",
              background: `linear-gradient(145deg, ${alpha("#FFFFFF", 0.9)}, ${alpha("#EAF1FF", 0.76)})`,
              backdropFilter: "blur(16px)",
              borderColor: alpha(brand.primary, 0.14),
            }
          : undefined
      }
    >
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              {t("credits.balance").toUpperCase()}
            </Typography>
            <Typography variant="h4" sx={{ color: brand.primary, fontWeight: 700 }}>
              {summary.balance}
            </Typography>
          </Box>

          {summary.balance === 0 && (
            <Alert severity="warning">{t("credits.outOfCredits")}</Alert>
          )}

          {expiringSoon > 0 && (
            <Alert severity="info">
              {t("credits.expiringOn", {
                count: expiringSoon,
                source: t(`credits.source.${soon[0]!.reason}`, {
                  defaultValue: soon[0]!.reason,
                }),
                date: new Date(soon[0]!.expiresAt).toLocaleDateString(),
              })}
            </Alert>
          )}

          {compact && (
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <Button component={RouterLink} to="/billing" variant="contained">
                {t("nav.buyCredits")}
              </Button>
              <Button component={RouterLink} to="/receipts" variant="outlined">
                {t("nav.receipts")}
              </Button>
            </Stack>
          )}

          {!compact && <Box>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              {t("credits.whatThingsCost").toUpperCase()}
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
              {Object.entries(summary.costs).map(([action, cost]) => (
                <Chip
                  key={action}
                  size="small"
                  variant="outlined"
                  label={`${t(`credits.action.${action}`, { defaultValue: action })} · ${cost}`}
                />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" display="block">
              {t("credits.freeActions")}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t("credits.lifetimes")}
            </Typography>
          </Box>}

          {!compact && summary.recent.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary" fontWeight={700}>
                {t("credits.recentActivity").toUpperCase()}
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {summary.recent.slice(0, 8).map((e, i) => (
                  <Stack key={i} direction="row" justifyContent="space-between">
                    <Typography variant="body2" color="text.secondary">
                      {t(`credits.action.${e.action}`, { defaultValue: e.action })} ·{" "}
                      {new Date(e.createdAt).toLocaleDateString()}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{ fontWeight: 600, color: e.delta > 0 ? "success.main" : "text.primary" }}
                    >
                      {e.delta > 0 ? `+${e.delta}` : e.delta}
                    </Typography>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
