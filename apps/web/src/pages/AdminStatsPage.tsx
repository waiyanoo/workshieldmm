/**
 * Platform statistics.
 *
 * The period boundaries are computed HERE, in the viewer's own timezone, and
 * sent as instants. "Today" has to mean today in Yangon, and a server deciding
 * that from a UTC clock is wrong by six and a half hours every day — which for
 * a "today" figure means most of the working evening lands on the wrong date.
 *
 * The chart is drawn as plain SVG rather than pulled from a charting library:
 * it is one series of bars with a hover label, and a dependency that ships a
 * layout engine to draw rectangles is not worth the bundle.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Card,
  CardContent,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import BusinessIcon from "@mui/icons-material/Business";
import VerifiedIcon from "@mui/icons-material/Verified";
import BoltIcon from "@mui/icons-material/Bolt";
import PaymentsIcon from "@mui/icons-material/Payments";
import DescriptionIcon from "@mui/icons-material/Description";
import ThumbUpIcon from "@mui/icons-material/ThumbUpAlt";
import ThumbDownIcon from "@mui/icons-material/ThumbDownAlt";
import PercentIcon from "@mui/icons-material/Percent";
import SpeedIcon from "@mui/icons-material/Speed";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { PageHeader, ScrollableTable, StatCard } from "../components/ui";
import { useTierB } from "../hooks/useTierB";

type PresetKey = "today" | "week" | "month" | "year" | "custom";

interface Stats {
  period: { from: string; to: string; bucket: "day" | "month" };
  onboarding: {
    registered: number;
    verified: number;
    firstCheck: number;
    totals: { pending: number; verified: number; suspended: number; all: number };
  };
  credits: {
    used: number;
    usedBy: { action: string; credits: number; events: number }[];
    granted: number;
    grantedBy: { reason: string; credits: number; lots: number }[];
    expired: number;
    reversed: number;
    spendingCompanies: number;
    outstanding: number;
    expiringNext30Days: number;
  };
  purchases: {
    creditsSold: number;
    creditPackPayments: number;
    creditPackMmk: number;
    subscriptionPayments: number;
    subscriptionMmk: number;
    totalMmk: number;
    byProvider: { provider: string; payments: number; amountMmk: number }[];
    awaitingReview: number;
    awaitingReviewMmk: number;
    rejected: number;
  };
  reports: {
    drafted: number;
    submitted: number;
    accepted: number;
    rejected: number;
    withdrawn: number;
    expired: number;
    decided: number;
    acceptanceRate: number | null;
    pending: number;
    oldestPendingHours: number | null;
    published: number;
    turnaround: {
      decided: number;
      avgHours: number | null;
      medianHours: number | null;
      p90Hours: number | null;
    };
    byCategory: { name: string; submitted: number; accepted: number; rejected: number }[];
    byReviewer: { reviewer: string; accepted: number; rejected: number }[];
    access: { requested: number; approved: number; denied: number; open: number };
  };
  series: {
    bucket: string;
    registered: number;
    verified: number;
    creditsUsed: number;
    creditsSold: number;
    revenueMmk: number;
  }[];
}

const mmk = (n: number) => `${n.toLocaleString()} MMK`;

/** Hours as something readable: "40m", "6h", "2d 4h". */
function hours(v: number | null, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (v === null) return "—";
  if (v < 1) return t("stats.underAnHour");
  if (v < 24) return t("stats.hoursShort", { count: Math.round(v) });
  return t("stats.daysShort", { days: Math.floor(v / 24), hours: Math.round(v % 24) });
}

/**
 * Period bounds in the viewer's local timezone, as [start, endExclusive].
 *
 * The end is "now" rather than the end of the period: nobody wants a monthly
 * figure that reads as though the rest of the month has already happened.
 */
function boundsFor(preset: PresetKey, now = new Date()): [Date, Date] {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case "today":
      return [startOfDay, now];
    case "week": {
      // Monday-start: the Myanmar working week, and the one the ISO calendar
      // agrees with. getDay() is 0 on Sunday, which is 6 days into that week.
      const back = (now.getDay() + 6) % 7;
      const monday = new Date(startOfDay);
      monday.setDate(monday.getDate() - back);
      return [monday, now];
    }
    case "month":
      return [new Date(now.getFullYear(), now.getMonth(), 1), now];
    case "year":
      return [new Date(now.getFullYear(), 0, 1), now];
    default:
      return [startOfDay, now];
  }
}

/** "YYYY-MM-DD" from a local date, for the date inputs. No UTC round trip. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// --- Chart ------------------------------------------------------------------

function BarChart({
  data,
  label,
  color,
  format,
}: {
  data: { bucket: string; value: number }[];
  label: string;
  color: string;
  format?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const show = format ?? ((n: number) => n.toLocaleString());

  return (
    <Box>
      <Typography variant="caption" color="text.secondary" fontWeight={700}>
        {label}
      </Typography>
      <Stack
        direction="row"
        alignItems="flex-end"
        justifyContent="flex-start"
        spacing={0.5}
        height={120}
        mt={1}
      >
        {data.map((d) => (
          <Tooltip key={d.bucket} title={`${d.bucket} · ${show(d.value)}`} arrow>
            <Box
              sx={{
                flex: 1,
                minWidth: 3,
                // Capped, so a one- or two-day period draws bars rather than a
                // solid slab across the card.
                maxWidth: 56,
                // A zero bar still gets a sliver so the axis reads as a
                // timeline rather than as missing data.
                height: `${Math.max(2, (d.value / max) * 100)}%`,
                bgcolor: d.value === 0 ? "action.disabledBackground" : color,
                borderRadius: 0.5,
                transition: "opacity .15s",
                "&:hover": { opacity: 0.75 },
              }}
            />
          </Tooltip>
        ))}
      </Stack>
      <Stack direction="row" justifyContent="space-between" mt={0.5}>
        <Typography variant="caption" color="text.secondary">
          {data[0]?.bucket ?? ""}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {data[data.length - 1]?.bucket ?? ""}
        </Typography>
      </Stack>
    </Box>
  );
}

// --- Page --------------------------------------------------------------------

export function AdminStatsPage() {
  const { t } = useTranslation();
  const tierB = useTierB();
  const [preset, setPreset] = useState<PresetKey>("month");
  const [customFrom, setCustomFrom] = useState(isoDay(new Date()));
  const [customTo, setCustomTo] = useState(isoDay(new Date()));
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [from, to] = useMemo<[Date, Date]>(() => {
    if (preset !== "custom") return boundsFor(preset);
    const start = new Date(`${customFrom}T00:00:00`);
    // Exclusive end at the start of the day after, so a single-day custom range
    // covers that whole day rather than nothing at all.
    const end = new Date(`${customTo}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return [start, end];
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        // getTimezoneOffset is minutes BEHIND UTC, so it is negated to give
        // minutes to add to UTC. Yangon reports -390 and we send +390.
        tzOffsetMinutes: String(-new Date().getTimezoneOffset()),
      });
      setStats(await api<Stats>(`/admin/stats?${params}`));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const p = stats?.purchases;
  const c = stats?.credits;
  const r = stats?.reports;

  return (
    <Stack spacing={3}>
      <PageHeader title={t("stats.title")} subtitle={t("stats.subtitle")} />

      {/* --- Period --- */}
      <Card>
        <CardContent>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            alignItems={{ md: "center" }}
          >
            <ToggleButtonGroup
              size="small"
              exclusive
              value={preset}
              onChange={(_, v: PresetKey | null) => v && setPreset(v)}
            >
              <ToggleButton value="today">{t("stats.today")}</ToggleButton>
              <ToggleButton value="week">{t("stats.thisWeek")}</ToggleButton>
              <ToggleButton value="month">{t("stats.thisMonth")}</ToggleButton>
              <ToggleButton value="year">{t("stats.thisYear")}</ToggleButton>
              <ToggleButton value="custom">{t("stats.custom")}</ToggleButton>
            </ToggleButtonGroup>

            {preset === "custom" && (
              <Stack direction="row" spacing={1.5} alignItems="center">
                <TextField
                  size="small"
                  type="date"
                  label={t("stats.from")}
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
                <TextField
                  size="small"
                  type="date"
                  label={t("stats.to")}
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Stack>
            )}

            <Box flex={1} />
            <Typography variant="caption" color="text.secondary">
              {t("stats.periodNote", {
                from: from.toLocaleString(),
                to: to.toLocaleString(),
              })}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      {error && <Alert severity="error">{error}</Alert>}

      {/* --- Headline --- */}
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <StatCard
          label={t("stats.companiesOnboarded")}
          value={stats?.onboarding.registered ?? "…"}
          icon={<BusinessIcon />}
        />
        <StatCard
          label={t("stats.companiesVerified")}
          value={stats?.onboarding.verified ?? "…"}
          icon={<VerifiedIcon />}
          tone="#0E9384"
        />
        <StatCard
          label={t("stats.creditsUsed")}
          value={c?.used.toLocaleString() ?? "…"}
          icon={<BoltIcon />}
          tone="#B54708"
        />
        <StatCard
          label={t("stats.revenue")}
          value={p ? mmk(p.totalMmk) : "…"}
          icon={<PaymentsIcon />}
          tone="#6941C6"
        />
      </Stack>

      {/* --- Chart --- */}
      {stats && stats.series.length > 0 && (
        <Card>
          <CardContent>
            <Typography variant="subtitle2" mb={2}>
              {t(stats.period.bucket === "day" ? "stats.byDay" : "stats.byMonth")}
            </Typography>
            <Stack direction={{ xs: "column", md: "row" }} spacing={4}>
              <Box flex={1}>
                <BarChart
                  label={t("stats.companiesOnboarded")}
                  color="#2F6BFF"
                  data={stats.series.map((s) => ({ bucket: s.bucket, value: s.registered }))}
                />
              </Box>
              <Box flex={1}>
                <BarChart
                  label={t("stats.creditsUsed")}
                  color="#B54708"
                  data={stats.series.map((s) => ({ bucket: s.bucket, value: s.creditsUsed }))}
                />
              </Box>
              <Box flex={1}>
                <BarChart
                  label={t("stats.revenue")}
                  color="#6941C6"
                  format={mmk}
                  data={stats.series.map((s) => ({ bucket: s.bucket, value: s.revenueMmk }))}
                />
              </Box>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Stack direction={{ xs: "column", lg: "row" }} spacing={3} alignItems="stretch">
        {/* --- Onboarding --- */}
        <Card sx={{ flex: 1 }}>
          <CardContent>
            <Typography variant="subtitle2" mb={2}>
              {t("stats.onboarding")}
            </Typography>
            <Stack spacing={1}>
              <Row label={t("stats.registered")} value={stats?.onboarding.registered} />
              <Row label={t("stats.verifiedInPeriod")} value={stats?.onboarding.verified} />
              <Row label={t("stats.firstCheck")} value={stats?.onboarding.firstCheck} />
            </Stack>

            <Typography variant="caption" color="text.secondary" display="block" mt={2} mb={1}>
              {t("stats.allTimeTotals")}
            </Typography>
            <Stack spacing={1}>
              <Row label={t("status.verified")} value={stats?.onboarding.totals.verified} />
              <Row label={t("status.pending")} value={stats?.onboarding.totals.pending} />
              <Row label={t("status.suspended")} value={stats?.onboarding.totals.suspended} />
            </Stack>
          </CardContent>
        </Card>

        {/* --- Credits --- */}
        <Card sx={{ flex: 1 }}>
          <CardContent>
            <Typography variant="subtitle2" mb={2}>
              {t("stats.creditUsage")}
            </Typography>
            {c && c.usedBy.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("stats.noUsage")}
              </Typography>
            ) : (
              <ScrollableTable minWidth={320}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("stats.action")}</TableCell>
                    <TableCell align="right">{t("stats.times")}</TableCell>
                    <TableCell align="right">{t("common.credits")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(c?.usedBy ?? []).map((u) => (
                    <TableRow key={u.action}>
                      <TableCell>
                        {t(`credits.action.${u.action}`, { defaultValue: u.action })}
                      </TableCell>
                      <TableCell align="right">{u.events.toLocaleString()}</TableCell>
                      <TableCell align="right">{u.credits.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </ScrollableTable>
            )}

            <Stack spacing={1} mt={2}>
              <Row label={t("stats.spendingCompanies")} value={c?.spendingCompanies} />
              <Row label={t("stats.creditsGranted")} value={c?.granted} />
              {/* Expiry is not usage, and saying so on the page stops the two
                  being read as one number. */}
              <Row label={t("stats.creditsExpired")} value={c?.expired} muted />
              <Row label={t("stats.creditsOutstanding")} value={c?.outstanding} muted />
              <Row label={t("stats.expiringSoon")} value={c?.expiringNext30Days} muted />
            </Stack>
          </CardContent>
        </Card>

        {/* --- Money --- */}
        <Card sx={{ flex: 1 }}>
          <CardContent>
            <Typography variant="subtitle2" mb={2}>
              {t("stats.purchases")}
            </Typography>
            <Stack spacing={1}>
              <Row label={t("stats.creditsSold")} value={p?.creditsSold} />
              <Row
                label={t("stats.creditPackRevenue", { count: p?.creditPackPayments ?? 0 })}
                text={p ? mmk(p.creditPackMmk) : undefined}
              />
              <Row
                label={t("stats.subscriptionRevenue", { count: p?.subscriptionPayments ?? 0 })}
                text={p ? mmk(p.subscriptionMmk) : undefined}
              />
              <Row label={t("stats.totalRevenue")} text={p ? mmk(p.totalMmk) : undefined} strong />
            </Stack>

            {(p?.byProvider.length ?? 0) > 0 && (
              <>
                <Typography variant="caption" color="text.secondary" display="block" mt={2} mb={1}>
                  {t("stats.byMethod")}
                </Typography>
                <Stack spacing={1}>
                  {p!.byProvider.map((b) => (
                    <Row
                      key={b.provider}
                      label={t(`stats.provider.${b.provider}`, { defaultValue: b.provider })}
                      text={`${mmk(b.amountMmk)} · ${b.payments}`}
                    />
                  ))}
                </Stack>
              </>
            )}

            <Typography variant="caption" color="text.secondary" display="block" mt={2} mb={1}>
              {t("stats.pipeline")}
            </Typography>
            <Stack spacing={1}>
              <Row
                label={t("stats.awaitingReview", { count: p?.awaitingReview ?? 0 })}
                text={p ? mmk(p.awaitingReviewMmk) : undefined}
              />
              <Row label={t("stats.rejectedPayments")} value={p?.rejected} muted />
            </Stack>
          </CardContent>
        </Card>
      </Stack>

      {/* --- Conduct report review ---
          Shown when Tier B is switched on, and also when it is off but the
          platform still holds reports from when it was on: hiding history a
          Super Admin is accountable for would be the wrong kind of tidy. */}
      {r && (tierB || r.submitted > 0 || r.published > 0 || r.pending > 0) && (
        <Card>
          <CardContent>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="baseline"
              flexWrap="wrap"
              useFlexGap
              mb={2}
            >
              <Typography variant="subtitle2">{t("stats.reportReview")}</Typography>
              {!tierB && (
                <Typography variant="caption" color="warning.main">
                  {t("stats.tierBOffNote")}
                </Typography>
              )}
            </Stack>

            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap mb={3}>
              <StatCard
                label={t("stats.reportsSubmitted")}
                value={r.submitted}
                icon={<DescriptionIcon />}
                tone="#9F1AB1"
              />
              <StatCard
                label={t("stats.reportsAccepted")}
                value={r.accepted}
                icon={<ThumbUpIcon />}
                tone="#067647"
              />
              <StatCard
                label={t("stats.reportsRejected")}
                value={r.rejected}
                icon={<ThumbDownIcon />}
                tone="#B42318"
              />
              {/* Null, not zero, when nothing was decided \u2014 "0% accepted" and
                  "nothing to accept" say very different things, and only one
                  of them means something has gone wrong. */}
              <StatCard
                label={t("stats.acceptanceRate")}
                value={r.acceptanceRate === null ? "\u2014" : `${r.acceptanceRate}%`}
                icon={<PercentIcon />}
                tone="#175CD3"
              />
              <StatCard
                label={t("stats.reportTurnaround")}
                value={hours(r.turnaround.medianHours, t)}
                icon={<SpeedIcon />}
                tone="#6941C6"
              />
            </Stack>

            <Stack direction={{ xs: "column", lg: "row" }} spacing={4}>
              <Box flex={1}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>
                  {t("stats.reportLifecycle")}
                </Typography>
                <Stack spacing={1} mt={1}>
                  <Row label={t("stats.reportsDrafted")} value={r.drafted} muted />
                  <Row label={t("stats.reportsSubmitted")} value={r.submitted} />
                  <Row label={t("stats.reportsAccepted")} value={r.accepted} />
                  <Row label={t("stats.reportsRejected")} value={r.rejected} />
                  <Row label={t("stats.reportsWithdrawn")} value={r.withdrawn} muted />
                  <Row label={t("stats.reportsExpired")} value={r.expired} muted />
                </Stack>

                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontWeight={700}
                  display="block"
                  mt={2}
                >
                  {t("stats.reportQueue")}
                </Typography>
                <Stack spacing={1} mt={1}>
                  <Row label={t("stats.awaitingReview2")} value={r.pending} />
                  <Row label={t("stats.oldestWaiting")} text={hours(r.oldestPendingHours, t)} />
                  <Row label={t("stats.publishedNow")} value={r.published} muted />
                  <Row
                    label={t("stats.turnaroundP90")}
                    text={hours(r.turnaround.p90Hours, t)}
                    muted
                  />
                </Stack>
              </Box>

              <Box flex={1}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>
                  {t("stats.byCategory")}
                </Typography>
                {r.byCategory.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" mt={1}>
                    {t("stats.noReports")}
                  </Typography>
                ) : (
                  <ScrollableTable minWidth={340}>
                    <TableHead>
                      <TableRow>
                        <TableCell>{t("stats.category")}</TableCell>
                        <TableCell align="right">{t("stats.subShort")}</TableCell>
                        <TableCell align="right">{t("stats.accShort")}</TableCell>
                        <TableCell align="right">{t("stats.rejShort")}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {r.byCategory.map((cat) => (
                        <TableRow key={cat.name}>
                          <TableCell>{cat.name}</TableCell>
                          <TableCell align="right">{cat.submitted}</TableCell>
                          <TableCell align="right">{cat.accepted}</TableCell>
                          <TableCell align="right">{cat.rejected}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </ScrollableTable>
                )}
              </Box>

              <Box flex={1}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>
                  {t("stats.byReviewer")}
                </Typography>
                {r.byReviewer.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" mt={1}>
                    {t("stats.noDecisions")}
                  </Typography>
                ) : (
                  <>
                    <ScrollableTable minWidth={300}>
                      <TableHead>
                        <TableRow>
                          <TableCell>{t("queue.assignee")}</TableCell>
                          <TableCell align="right">{t("stats.accShort")}</TableCell>
                          <TableCell align="right">{t("stats.rejShort")}</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {r.byReviewer.map((rv) => (
                          <TableRow key={rv.reviewer}>
                            <TableCell>{rv.reviewer}</TableCell>
                            <TableCell align="right">{rv.accepted}</TableCell>
                            <TableCell align="right">{rv.rejected}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </ScrollableTable>
                    {/* Not a leaderboard. It is here so a reviewer who accepts
                        everything, or rejects everything, is visible instead of
                        averaged away across the team. */}
                    <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                      {t("stats.byReviewerNote")}
                    </Typography>
                  </>
                )}

                <Typography
                  variant="caption"
                  color="text.secondary"
                  fontWeight={700}
                  display="block"
                  mt={2}
                >
                  {t("stats.reportAccess")}
                </Typography>
                <Stack spacing={1} mt={1}>
                  <Row label={t("stats.accessRequested")} value={r.access.requested} />
                  <Row label={t("stats.accessApproved")} value={r.access.approved} />
                  <Row label={t("stats.accessDenied")} value={r.access.denied} />
                  <Row label={t("stats.accessOpen")} value={r.access.open} muted />
                </Stack>
              </Box>
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function Row({
  label,
  value,
  text,
  muted,
  strong,
}: {
  label: string;
  value?: number;
  text?: string;
  muted?: boolean;
  strong?: boolean;
}) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={2}>
      <Typography variant="body2" color={muted ? "text.secondary" : "text.primary"}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        fontWeight={strong ? 700 : 600}
        color={muted ? "text.secondary" : "text.primary"}
        sx={{ whiteSpace: "nowrap" }}
      >
        {text ?? (value === undefined ? "…" : value.toLocaleString())}
      </Typography>
    </Stack>
  );
}
