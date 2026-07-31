import { useState, type ReactNode } from "react";
import { alpha } from "@mui/material/styles";
import {
  AppBar,
  Avatar,
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import LogoutIcon from "@mui/icons-material/Logout";
import ShieldIcon from "@mui/icons-material/Shield";
import DashboardIcon from "@mui/icons-material/SpaceDashboard";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import DescriptionIcon from "@mui/icons-material/Description";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import RuleIcon from "@mui/icons-material/Rule";
import BusinessIcon from "@mui/icons-material/Business";
import ReceiptLongIcon from "@mui/icons-material/ReceiptLong";
import PaymentsIcon from "@mui/icons-material/Payments";
import AccountCircleIcon from "@mui/icons-material/AccountCircle";
import InsightsIcon from "@mui/icons-material/Insights";
import PolicyIcon from "@mui/icons-material/Policy";
import KeyIcon from "@mui/icons-material/VpnKey";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NotificationBell } from "./NotificationBell";
import { useAuth } from "../auth/AuthContext";
import { useTierB } from "../hooks/useTierB";
import { useCompanyStatus } from "../hooks/useCompanyStatus";
import { brand } from "../theme";

const DRAWER_WIDTH = 252;

interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
}

interface NavSection {
  header?: string;
  items: NavItem[];
}

type Translate = (key: string) => string;

function navFor(
  role: string,
  userType: string,
  tierB: boolean,
  companyVerified: boolean,
  t: Translate
): NavSection[] {
  const sections: NavSection[] = [
    { items: [{ label: t("nav.dashboard"), to: "/", icon: <DashboardIcon /> }] },
  ];

  if (userType === "company") {
    // An unverified company can do exactly two things: finish its application
    // and keep its contact details current. Listing screening and billing while
    // every action behind them is refused is how a customer learns the platform
    // is broken rather than that their application is still open.
    if (!companyVerified) {
      sections.push({
        header: t("nav.account"),
        items: [{ label: t("nav.profile"), to: "/profile", icon: <AccountCircleIcon /> }],
      });
      return sections;
    }

    const items: NavItem[] = [
      { label: t("nav.verifications"), to: "/verifications", icon: <FactCheckIcon /> },
    ];
    if (tierB) {
      items.push(
        { label: t("nav.reports"), to: "/reports", icon: <DescriptionIcon /> },
        { label: t("nav.reportAccess"), to: "/report-access", icon: <TravelExploreIcon /> }
      );
    }
    sections.push({ header: t("nav.screening"), items });
    sections.push({
      header: t("nav.billing"),
      items: [
        { label: t("nav.buyCredits"), to: "/billing", icon: <PaymentsIcon /> },
        { label: t("nav.receipts"), to: "/receipts", icon: <ReceiptLongIcon /> },
      ],
    });
    sections.push({
      header: t("nav.account"),
      items: [{ label: t("nav.profile"), to: "/profile", icon: <AccountCircleIcon /> }],
    });
  }

  if (role === "admin_reviewer" || role === "super_admin") {
    const items: NavItem[] = [
      { label: t("nav.checkQueue"), to: "/admin/verifications", icon: <RuleIcon /> },
    ];
    if (tierB) {
      items.push(
        { label: t("nav.reportReview"), to: "/admin/reports", icon: <DescriptionIcon /> },
        { label: t("nav.accessRequests"), to: "/admin/access-requests", icon: <KeyIcon /> }
      );
    }
    sections.push({ header: t("nav.review"), items });
  }

  if (role === "super_admin") {
    const items: NavItem[] = [
      { label: t("nav.stats"), to: "/admin/stats", icon: <InsightsIcon /> },
      { label: t("nav.companies"), to: "/admin/companies", icon: <BusinessIcon /> },
      { label: t("nav.payments"), to: "/admin/payments", icon: <PaymentsIcon /> },
      { label: t("nav.auditLogs"), to: "/admin/audit", icon: <ReceiptLongIcon /> },
    ];
    if (tierB) {
      items.splice(0, 0, {
        label: t("nav.oversight"),
        to: "/admin/oversight",
        icon: <PolicyIcon />,
      });
    }
    sections.push({ header: t("nav.platform"), items });
  }

  return sections;
}

// Translation keys, not labels — the header and the sidebar then always agree,
// and adding a language does not mean updating two maps.
const PAGE_TITLES: Record<string, string> = {
  "/": "nav.dashboard",
  "/verifications": "nav.verifications",
  "/reports": "nav.reports",
  "/report-access": "nav.reportAccess",
  "/billing": "nav.buyCredits",
  "/receipts": "nav.receipts",
  "/profile": "nav.profile",
  "/admin/payments": "nav.payments",
  "/admin/verifications": "nav.checkQueue",
  "/admin/reports": "nav.reportReview",
  "/admin/oversight": "nav.oversight",
  "/admin/access-requests": "nav.accessRequests",
  "/admin/stats": "nav.stats",
  "/admin/companies": "nav.companies",
  "/admin/audit": "nav.auditLogs",
};

function SidebarContent() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const tierB = useTierB();
  const company = useCompanyStatus();
  if (!user) return null;

  const roleLabel = user.role.replace(/_/g, " ");

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: `linear-gradient(180deg, ${brand.navy} 0%, ${brand.navyLight} 100%)`,
        color: "#fff",
      }}
    >
      {/* Brand */}
      <Stack direction="row" spacing={1.5} alignItems="center" px={2.5} py={2.5}>
        <Box
          sx={{
            width: 38,
            height: 38,
            borderRadius: 2.5,
            display: "grid",
            placeItems: "center",
            background: `linear-gradient(135deg, ${brand.primary}, ${brand.teal})`,
            boxShadow: "0 4px 12px rgba(47,107,255,0.4)",
          }}
        >
          <ShieldIcon sx={{ fontSize: 22, color: "#fff" }} />
        </Box>
        <Box>
          <Typography fontWeight={700} fontSize={17} lineHeight={1.2}>
            WorkShield{" "}
            <Box component="span" sx={{ color: "#6EA8FE" }}>
              MM
            </Box>
          </Typography>
          <Typography fontSize={11} sx={{ color: alpha("#fff", 0.55) }}>
            {t("app.tagline")}
          </Typography>
        </Box>
      </Stack>

      <Divider sx={{ borderColor: alpha("#fff", 0.08) }} />

      {/* Navigation */}
      <Box sx={{ flex: 1, overflowY: "auto", py: 1 }}>
        {navFor(user.role, user.userType, tierB, company.isVerified, t).map((section, i) => (
          <List
            key={i}
            dense
            subheader={
              section.header ? (
                <ListSubheader
                  disableSticky
                  sx={{
                    bgcolor: "transparent",
                    color: alpha("#fff", 0.45),
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    lineHeight: 2.5,
                    px: 2.5,
                  }}
                >
                  {section.header}
                </ListSubheader>
              ) : undefined
            }
          >
            {section.items.map((item) => {
              const selected = location.pathname === item.to;
              return (
                <ListItemButton
                  key={item.to}
                  component={RouterLink}
                  to={item.to}
                  selected={selected}
                  sx={{
                    mx: 1.5,
                    my: 0.25,
                    borderRadius: 2,
                    color: alpha("#fff", 0.75),
                    "& .MuiListItemIcon-root": { color: alpha("#fff", 0.55), minWidth: 38 },
                    "&.Mui-selected": {
                      bgcolor: alpha(brand.primary, 0.28),
                      color: "#fff",
                      "& .MuiListItemIcon-root": { color: "#8FB5FF" },
                      "&:hover": { bgcolor: alpha(brand.primary, 0.34) },
                    },
                    "&:hover": { bgcolor: alpha("#fff", 0.06) },
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{ fontSize: 14, fontWeight: selected ? 600 : 500 }}
                  />
                </ListItemButton>
              );
            })}
          </List>
        ))}
      </Box>

      {/* User */}
      <Divider sx={{ borderColor: alpha("#fff", 0.08) }} />
      <Stack direction="row" spacing={1.5} alignItems="center" px={2} py={2}>
        <Avatar
          sx={{
            width: 34,
            height: 34,
            fontSize: 14,
            fontWeight: 700,
            bgcolor: alpha(brand.primary, 0.35),
            color: "#CFE0FF",
            textTransform: "uppercase",
          }}
        >
          {roleLabel.slice(0, 1)}
        </Avatar>
        <Box flex={1} minWidth={0}>
          <Typography fontSize={13} fontWeight={600} sx={{ textTransform: "capitalize" }}>
            {roleLabel}
          </Typography>
          <Typography fontSize={11} sx={{ color: alpha("#fff", 0.5) }}>
            {user.userType === "platform" ? "Platform staff" : "Company account"}
          </Typography>
        </Box>
        <Tooltip title={t("nav.signOut")}>
          <IconButton
            size="small"
            onClick={() => {
              logout();
              navigate("/login");
            }}
            sx={{ color: alpha("#fff", 0.6), "&:hover": { color: "#fff" } }}
          >
            <LogoutIcon fontSize="small" />
          </IconButton>
        </Tooltip>

      </Stack>
    </Box>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const location = useLocation();
  const tierB = useTierB();
  const [mobileOpen, setMobileOpen] = useState(false);

  // The header title is derived from the route, so it reads from the same nav
  // keys as the sidebar rather than a second English-only map.
  // Exact match first, then the longest matching prefix, so a detail route
  // like /admin/companies/:id is headed by its section rather than falling all
  // the way back to the product name.
  const titleKey =
    PAGE_TITLES[location.pathname] ??
    Object.entries(PAGE_TITLES)
      .filter(([path]) => path !== "/" && location.pathname.startsWith(`${path}/`))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  const title = titleKey ? t(titleKey) : "WorkShield MM";

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      {/* Desktop sidebar */}
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: "none", md: "block" },
          width: DRAWER_WIDTH,
          flexShrink: 0,
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH, border: 0 },
        }}
        open
      >
        <SidebarContent />
      </Drawer>

      {/* Mobile sidebar */}
      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: "block", md: "none" },
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH, border: 0 },
        }}
      >
        <SidebarContent />
      </Drawer>

      {/* Main */}
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
            bgcolor: alpha("#FFFFFF", 0.85),
            backdropFilter: "blur(8px)",
            color: "text.primary",
            borderBottom: 1,
            borderColor: "divider",
          }}
        >
          <Toolbar sx={{ minHeight: 60 }}>
            <IconButton
              edge="start"
              onClick={() => setMobileOpen(true)}
              sx={{ mr: 1, display: { md: "none" } }}
            >
              <MenuIcon />
            </IconButton>
            <Typography variant="h6" sx={{ flex: 1 }}>
              {title}
            </Typography>
            <Stack direction="row" spacing={0.5} alignItems="center">
              {!tierB && (
                <Chip
                  size="small"
                  label={t("nav.tierBDisabledChip")}
                  sx={{
                    bgcolor: alpha("#F59E0B", 0.12),
                    color: "#B54708",
                    border: `1px solid ${alpha("#F59E0B", 0.3)}`,
                    mr: 1,
                  }}
                />
              )}
              {/* Notices are company-facing; platform staff have the admin
                  queues, which serve the same purpose for them. */}
              {user?.userType === "company" && <NotificationBell />}
              <LanguageSwitcher />
            </Stack>
          </Toolbar>
        </AppBar>

        <Box component="main" sx={{ flex: 1, p: { xs: 2, sm: 3, md: 4 }, maxWidth: 1200, width: "100%", mx: "auto" }}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}
