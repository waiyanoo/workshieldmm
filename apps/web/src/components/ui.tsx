/** Shared UI primitives for the WorkShield MM dashboard. */
import { Children, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { alpha } from "@mui/material/styles";
import type { SxProps, Theme } from "@mui/material/styles";
import {
  Box,
  Card,
  CardContent,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";

// --- Scrollable table ----------------------------------------------------------

/**
 * A wide table that becomes labelled cards on phones and tablets instead of
 * crushing its columns. On desktop screens, it keeps the familiar compact
 * table layout.
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
function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return textContent(child.props.children);
      return "";
    })
    .join(" ")
    .trim();
}

function addLabelsToRow(row: ReactNode, labels: string[]): ReactNode {
  if (!isValidElement<{ children?: ReactNode }>(row)) return row;

  if (row.type === TableRow) {
    return cloneElement(
      row as ReactElement<{ children?: ReactNode }>,
      undefined,
      Children.map(row.props.children, (cell, index) => {
        if (!isValidElement(cell) || cell.type !== TableCell) return cell;
        return cloneElement(cell as ReactElement, { "data-label": labels[index] ?? "" });
      }),
    );
  }

  // Report rows include a fragment for the expandable evidence panel. Preserve
  // that structure while applying labels to each actual table row inside it.
  if (row.type === Fragment) {
    return cloneElement(
      row as ReactElement<{ children?: ReactNode }>,
      undefined,
      Children.map(row.props.children, (child) => addLabelsToRow(child, labels)),
    );
  }

  return row;
}

function addMobileLabels(children: ReactNode): ReactNode {
  const sections = Children.toArray(children);
  const head = sections.find(
    (section): section is ReactElement<{ children?: ReactNode }> =>
      isValidElement<{ children?: ReactNode }>(section) && section.type === TableHead,
  );
  const headerRow = head && Children.toArray(head.props.children).find(
    (row): row is ReactElement<{ children?: ReactNode }> =>
      isValidElement<{ children?: ReactNode }>(row) && row.type === TableRow,
  );
  const labels = headerRow
    ? Children.toArray(headerRow.props.children).map((cell) =>
        isValidElement<{ children?: ReactNode }>(cell) ? textContent(cell.props.children) : "",
      )
    : [];

  if (labels.length === 0) return children;

  return sections.map((section) => {
    if (!isValidElement<{ children?: ReactNode }>(section) || section.type !== TableBody) return section;
    return cloneElement(
      section as ReactElement<{ children?: ReactNode }>,
      undefined,
      Children.map(section.props.children, (row) => addLabelsToRow(row, labels)),
    );
  });
}

export function ScrollableTable({
  minWidth = 780,
  children,
}: {
  minWidth?: number;
  children: ReactNode;
}) {
  return (
    <TableContainer sx={{ mx: -2, px: 2, width: "auto" }}>
      <Table
        size="small"
        sx={{
          minWidth,
          "@media (max-width: 899.95px)": {
            minWidth: 0,
            "& .MuiTableHead-root": { display: "none" },
            "& .MuiTableBody-root": { display: "block" },
            "& .MuiTableRow-root": {
              display: "block",
              mb: 1.5,
              overflow: "hidden",
              border: 1,
              borderColor: "divider",
              borderRadius: 2,
              "&:last-child": { mb: 0 },
            },
            "& .MuiTableCell-root": {
              display: "grid",
              gridTemplateColumns: "minmax(110px, 42%) minmax(0, 1fr)",
              gap: 1.5,
              alignItems: "start",
              px: 1.5,
              py: 1,
              textAlign: "left !important",
              borderBottom: 1,
              borderColor: "divider",
              "&::before": {
                content: "attr(data-label)",
                color: "text.secondary",
                fontSize: 12,
                fontWeight: 700,
                lineHeight: 1.5,
              },
              "&:last-child": { borderBottom: 0 },
            },
            "& .MuiTableCell-root[colspan]": {
              display: "block",
              "&::before": { display: "none" },
            },
            "@media (max-width: 599.95px)": {
              "& .MuiTableCell-root:last-child:not([colspan])": {
                gridTemplateColumns: "minmax(0, 1fr)",
                "&::before": { marginBottom: 0.5 },
              },
            },
          },
        }}
      >
        {addMobileLabels(children)}
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
      {action && (
        <Box sx={{ width: { xs: "100%", sm: "auto" }, "& > *": { width: { xs: "100%", sm: "auto" } } }}>
          {action}
        </Box>
      )}
    </Stack>
  );
}

// --- Bento surfaces ------------------------------------------------------------

export function GlassCard({
  children,
  sx,
}: {
  children: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Card
      sx={[
        {
          background: `linear-gradient(145deg, ${alpha("#FFFFFF", 0.92)}, ${alpha("#EEF4FF", 0.72)})`,
          backdropFilter: "blur(16px)",
          borderColor: alpha("#2F6BFF", 0.12),
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {children}
    </Card>
  );
}

export function BentoStatCard({
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
    <GlassCard sx={{ height: "100%", minHeight: 142, borderColor: alpha(tone, 0.16), background: `linear-gradient(145deg, ${alpha("#FFFFFF", 0.92)}, ${alpha(tone, 0.08)})` }}>
      <CardContent sx={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", p: 2.25 }}>
        <Box sx={{ width: 40, height: 40, borderRadius: 2.5, display: "grid", placeItems: "center", color: tone, bgcolor: alpha(tone, 0.12) }}>
          {icon}
        </Box>
        <Box sx={{ mt: 2 }}>
          <Typography variant="h4" lineHeight={1.1}>{value}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{label}</Typography>
        </Box>
      </CardContent>
    </GlassCard>
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
  // promotional pricing
  running: "#067647",
  scheduled: "#175CD3",
  ended: "#475467",
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
