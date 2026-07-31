/**
 * Notification bell.
 *
 * Messages arrive from the API as a `kind` plus params, never as prose — see
 * notifications.service.ts. The text is rendered here, in whichever language
 * the reader has selected, so a notice raised while the platform was in English
 * still reads in Burmese to a Burmese-speaking colleague.
 */
import { useEffect, useState } from "react";
import { alpha } from "@mui/material/styles";
import {
  Badge,
  Box,
  Button,
  Divider,
  IconButton,
  Menu,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import NotificationsIcon from "@mui/icons-material/Notifications";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { formatDateTime } from "../lib/date";

interface Notification {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  link: string | null;
  severity: "info" | "success" | "warning" | "error";
  readAt: string | null;
  createdAt: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  info: "#175CD3",
  success: "#067647",
  warning: "#B54708",
  error: "#B42318",
};

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  async function load() {
    try {
      const res = await api<{ unread: number; items: Notification[] }>("/notifications");
      setItems(res.items);
      setUnread(res.unread);
    } catch {
      // A failed poll should never break the shell it lives in.
    }
  }

  useEffect(() => {
    void load();
    // Cheap poll rather than websockets: this is a low-frequency, non-urgent
    // feed, and a minute of latency on "your document was approved" is fine.
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, []);

  async function openItem(n: Notification) {
    setAnchor(null);
    if (!n.readAt) {
      try {
        await api(`/notifications/${n.id}/read`, { method: "POST" });
      } catch {
        // Navigation matters more than the read receipt.
      }
    }
    await load();
    if (n.link) navigate(n.link);
  }

  async function markAll() {
    try {
      await api("/notifications/read-all", { method: "POST" });
      await load();
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <Tooltip title={t("notify.title")}>
        <IconButton
          size="small"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ color: "text.secondary", "&:hover": { color: "text.primary" } }}
        >
          <Badge badgeContent={unread} color="error" max={99}>
            <NotificationsIcon fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>

      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { width: 380, maxHeight: 460 } } }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" px={2} py={1}>
          <Typography variant="subtitle2">{t("notify.title")}</Typography>
          {unread > 0 && (
            <Button size="small" onClick={markAll}>
              {t("notify.markAllRead")}
            </Button>
          )}
        </Stack>
        <Divider />

        {items.length === 0 ? (
          <Box px={2} py={3}>
            <Typography variant="body2" color="text.secondary" align="center">
              {t("notify.empty")}
            </Typography>
          </Box>
        ) : (
          items.map((n) => (
            <Box
              key={n.id}
              onClick={() => void openItem(n)}
              sx={{
                px: 2,
                py: 1.25,
                cursor: "pointer",
                borderLeft: `3px solid ${SEVERITY_COLOR[n.severity] ?? "#475467"}`,
                // Unread entries are tinted so the list is scannable without
                // reading every line.
                bgcolor: n.readAt ? "transparent" : alpha("#2F6BFF", 0.05),
                "&:hover": { bgcolor: alpha("#2F6BFF", 0.09) },
              }}
            >
              <Typography variant="body2" sx={{ fontWeight: n.readAt ? 400 : 600 }}>
                {t(`notify.kind.${n.kind}`, {
                  ...n.params,
                  // Named lists arrive as arrays; join them for the sentence.
                  missing: Array.isArray(n.params.missing)
                    ? (n.params.missing as string[])
                        .map((m) => t(`documents.${m}`, { defaultValue: m }))
                        .join(", ")
                    : n.params.missing,
                  docType: n.params.docType
                    ? t(`documents.${n.params.docType}`, { defaultValue: String(n.params.docType) })
                    : "",
                  defaultValue: n.kind,
                })}
              </Typography>
              {typeof n.params.reason === "string" && n.params.reason && (
                <Typography variant="caption" color="text.secondary" display="block">
                  {n.params.reason}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary">
                {formatDateTime(n.createdAt)}
              </Typography>
            </Box>
          ))
        )}
      </Menu>
    </>
  );
}
