/** Shared UI primitives for the WorkShield MM dashboard. */
import type { ReactNode } from "react";
import { alpha } from "@mui/material/styles";
import {
  Box,
  Card,
  CardContent,
  Chip,
  Stack,
  Table,
  TableContainer,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";

// --- Scrollable table ----------------------------------------------------------

/**
 * A wide table that scrolls sideways instead of crushing its columns.
 *
 * The `minWidth` is the part that actually matters: a TableContainer on its own
 * never scrolls, because the table happily shrinks to whatever space it is
 * given and wraps every cell into a column one word wide. Giving the table a
 * floor forces the overflow the container then scrolls.
 *
 * This bites hardest in Burmese, where the same header runs noticeably longer
 * than its English equivalent, so admin grids that fit in English do not fit
 * once translated.
 *
 * The negative margin lets the scrolling area run to the card's edges, so the
 * content scrolls under the padding rather than being clipped inside it.
 */
export function ScrollableTable({
  minWidth = 780,
  children,
}: {
  minWidth?: number;
  children: ReactNode;
}) {
  return (
    <TableContainer sx={{ mx: -2, px: 2, width: "auto" }}>
      <Table size="small" sx={{ minWidth }}>
        {children}
      </Table>
    </TableContainer>
  );
}

// --- Page header ---------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      justifyContent="space-between"
      alignItems={{ xs: "flex-start", sm: "center" }}
      spacing={1.5}
      mb={3}
    >
      <Box>
        <Typography variant="h5">{title}</Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" mt={0.5}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {action}
    </Stack>
  );
}

// --- Stat card -------------------------------------------------------------------

export function StatCard({
  label,
  value,
  icon,
  tone = "#2F6BFF",
}: {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: string;
}) {
  return (
    <Card sx={{ flex: 1, minWidth: 180 }}>
      <CardContent sx={{ display: "flex", alignItems: "center", gap: 2, py: 2.5 }}>
        <Box
          sx={{
            width: 44,
            height: 44,
            borderRadius: 2.5,
            display: "grid",
            placeItems: "center",
            color: tone,
            bgcolor: alpha(tone, 0.12),
            flexShrink: 0,
          }}
        >
          {icon}
        </Box>
        <Box>
          <Typography variant="h5" lineHeight={1.2}>
            {value}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {label}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  );
}

// --- Status chip -------------------------------------------------------------------

// Colour only — the label is looked up per status in the locale files, so the
// two languages cannot drift apart from the styling.
const STATUS_COLORS: Record<string, string> = {
  // shared
  pending: "#B54708",
  // Parked on the employer, not on us — amber like `pending`, because from the
  // employer's side it is still an open item they have to act on.
  need_more_info: "#B54708",
  completed: "#067647",
  not_found: "#475467",
  verified: "#067647",
  suspended: "#B42318",
  active: "#067647",
  // Tier B report lifecycle
  draft: "#475467",
  pending_review: "#B54708",
  approved: "#067647",
  rejected: "#B42318",
  withdrawn: "#B42318",
  expired: "#475467",
  // payments
  awaiting_payment: "#B54708",
  submitted: "#175CD3",
  confirmed: "#067647",
  // access requests
  requested: "#B54708",
  denied: "#B42318",
};

export function StatusChip({ status, scope }: { status: string; scope?: string }) {
  const { t } = useTranslation();
  const color = STATUS_COLORS[status] ?? "#475467";
  // `approved` means different things in different places: a conduct report
  // that is approved is Published, a document that is approved is just
  // Approved. `scope` picks the narrower label (status.approved_doc) where one
  // exists and falls back to the shared one where it does not — so callers can
  // pass a scope without needing a full set of keys for it.
  const label = scope
    ? t(`status.${status}_${scope}`, {
        defaultValue: t(`status.${status}`, { defaultValue: status }),
      })
    : t(`status.${status}`, { defaultValue: status });
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        color,
        bgcolor: alpha(color, 0.1),
        border: `1px solid ${alpha(color, 0.25)}`,
      }}
    />
  );
}

// --- Empty state --------------------------------------------------------------------

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box textAlign="center" py={5}>
      <Typography variant="subtitle1" color="text.secondary">
        {title}
      </Typography>
      {hint && (
        <Typography variant="body2" color="text.secondary" mt={0.5}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}
