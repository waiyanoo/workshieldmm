import { alpha, createTheme } from "@mui/material/styles";

/**
 * WorkShield MM design tokens — modern dashboard look:
 * deep-navy sidebar, soft neutral canvas, card surfaces with hairline borders
 * and low shadows, pill buttons, and soft status chips.
 */
export const brand = {
  navy: "#0C1B31",
  navyLight: "#13294B",
  primary: "#2F6BFF",
  primaryDark: "#1F4FD8",
  teal: "#0FA48A",
  canvas: "#F4F6FB",
  ink: "#101828",
  inkMuted: "#667085",
  border: "#E9EDF5",
};

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: brand.primary, dark: brand.primaryDark, contrastText: "#fff" },
    secondary: { main: brand.teal },
    success: { main: "#12A150" },
    warning: { main: "#F59E0B" },
    error: { main: "#E5484D" },
    info: { main: "#3E63DD" },
    background: { default: brand.canvas, paper: "#FFFFFF" },
    text: { primary: brand.ink, secondary: brand.inkMuted },
    divider: brand.border,
  },
  shape: { borderRadius: 12 },
  typography: {
    // Myanmar faces come after the Latin ones: the browser falls through to
    // them only for Burmese codepoints, so English keeps Inter's metrics while
    // Burmese gets a font that can actually render it. Without a Myanmar face
    // present, Burmese shows as empty boxes on machines that lack one.
    fontFamily: `"Inter", "Segoe UI", system-ui, -apple-system, Roboto, "Noto Sans Myanmar", "Padauk", "Myanmar Text", Helvetica, Arial, sans-serif`,
    h4: { fontWeight: 700, letterSpacing: "-0.02em" },
    h5: { fontWeight: 700, letterSpacing: "-0.02em" },
    h6: { fontWeight: 600, letterSpacing: "-0.01em" },
    subtitle1: { fontWeight: 600 },
    button: { textTransform: "none", fontWeight: 600 },
    body2: { lineHeight: 1.6 },
  },
  components: {
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          borderRadius: 16,
          border: `1px solid ${brand.border}`,
          boxShadow: "0 1px 3px rgba(16,24,40,0.05), 0 1px 2px rgba(16,24,40,0.04)",
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 10,
          minHeight: 44,
          paddingLeft: 16,
          paddingRight: 16,
        },
        containedPrimary: {
          "&:hover": { backgroundColor: brand.primaryDark },
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: { fontWeight: 600, borderRadius: 8 },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        head: {
          color: brand.inkMuted,
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          borderBottom: `1px solid ${brand.border}`,
          background: "#FAFBFE",
        },
        root: { borderBottom: `1px solid ${brand.border}` },
      },
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 16 } },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: {
          "@media (max-width: 599.95px)": {
            alignItems: "stretch",
            flexDirection: "column",
            gap: 8,
            paddingLeft: 16,
            paddingRight: 16,
            "& > :not(style) ~ :not(style)": { marginLeft: 0 },
          },
        },
      },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: 10 } },
    },
    MuiTextField: {
      defaultProps: { size: "small" },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          backgroundColor: "#fff",
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: brand.primary,
            boxShadow: `0 0 0 3px ${alpha(brand.primary, 0.14)}`,
          },
        },
      },
    },
    MuiTooltip: {
      styleOverrides: { tooltip: { borderRadius: 8 } },
    },
  },
});
