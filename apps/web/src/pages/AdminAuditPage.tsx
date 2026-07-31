import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Stack,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { PageHeader, ScrollableTable } from "../components/ui";

interface AuditEntry {
  id: number;
  actorId: string | null;
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  timestamp: string;
}

const PAGE = 50;

const actorColor: Record<string, "default" | "primary" | "secondary"> = {
  admin: "primary",
  user: "secondary",
  system: "default",
};

export function AdminAuditPage() {
  const { t } = useTranslation();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function load(nextOffset = offset) {
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (action.trim()) params.set("action", action.trim());
      if (resourceType.trim()) params.set("resourceType", resourceType.trim());
      const res = await api<{ items: AuditEntry[] }>(`/admin/audit-logs?${params}`);
      setItems(res.items);
      setOffset(nextOffset);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load audit logs");
    }
  }

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack spacing={3}>
      <PageHeader
        title={t("admin.auditTitle")}
        subtitle={t("admin.auditSubtitle")}
      />
      {error && <Alert severity="error">{error}</Alert>}

      <Card>
        <CardContent>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} mb={2}>
            <TextField
              label={t("admin.filterAction")}
              size="small"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="e.g. company.verify"
              sx={{ minWidth: 220 }}
            />
            <TextField
              label={t("admin.filterResource")}
              size="small"
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
              placeholder="e.g. verification_request"
              sx={{ minWidth: 220 }}
            />
            <Button variant="contained" onClick={() => load(0)}>
              {t("admin.apply")}
            </Button>
          </Stack>

          {items.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {t("admin.noEntries")}
            </Typography>
          ) : (
            <ScrollableTable minWidth={820}>
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>{t("admin.time")}</TableCell>
                  <TableCell>{t("admin.actor")}</TableCell>
                  <TableCell>{t("admin.action")}</TableCell>
                  <TableCell>{t("admin.resource")}</TableCell>
                  <TableCell>{t("admin.metadata")}</TableCell>
                  <TableCell>IP</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell sx={{ color: "text.secondary" }}>{e.id}</TableCell>
                    <TableCell>{new Date(e.timestamp).toLocaleString()}</TableCell>
                    <TableCell>
                      <Tooltip title={e.actorId ?? "—"}>
                        <Chip size="small" label={e.actorType} color={actorColor[e.actorType] ?? "default"} />
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>{e.action}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {e.resourceType}
                      {e.resourceId ? `:${e.resourceId.slice(0, 8)}` : ""}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                      {Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : "—"}
                    </TableCell>
                    <TableCell>{e.ipAddress ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollableTable>
          )}

          <Stack direction="row" spacing={1} mt={2} justifyContent="flex-end">
            <Button size="small" disabled={offset === 0} onClick={() => load(Math.max(offset - PAGE, 0))}>
              Newer
            </Button>
            <Button size="small" disabled={items.length < PAGE} onClick={() => load(offset + PAGE)}>
              Older
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
