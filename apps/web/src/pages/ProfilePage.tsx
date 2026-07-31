/**
 * Company and personal profile.
 *
 * Locked fields are shown, not hidden. A company that cannot find its own legal
 * name assumes the data is missing and contacts support; a company that sees it
 * greyed out with a one-line reason understands why it cannot be edited here.
 */
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import LockIcon from "@mui/icons-material/Lock";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n/apiError";
import { useAuth } from "../auth/AuthContext";
import { PageHeader, StatusChip } from "../components/ui";

interface Profile {
  company: {
    id: string;
    legalName: string;
    registrationNumber: string;
    status: string;
    plan: string;
    registrationVerifiedAt: string | null;
    createdAt: string;
    phone: string | null;
    contactEmail: string | null;
    addressLine: string | null;
    township: string | null;
    city: string | null;
    region: string | null;
  };
  me: {
    fullName: string | null;
    email: string | null;
    role: string | null;
    phone: string | null;
    nationalId: string | null;
    mfaEnabled: boolean;
  };
  users: { id: string; fullName: string; email: string; role: string; status: string }[];
}

/** A value the company cannot change here, with the reason it is locked. */
function LockedField({ label, value, reason }: { label: string; value: string; reason: string }) {
  return (
    <Box>
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Typography variant="caption" color="text.secondary" fontWeight={700}>
          {label}
        </Typography>
        <LockIcon sx={{ fontSize: 13, color: "text.disabled" }} />
      </Stack>
      <Typography variant="body2">{value}</Typography>
      <Typography variant="caption" color="text.secondary">
        {reason}
      </Typography>
    </Box>
  );
}

export function ProfilePage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Company form
  const [phone, setPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [township, setTownship] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");

  // Personal form
  const [fullName, setFullName] = useState("");
  const [myPhone, setMyPhone] = useState("");

  const isAdmin = user?.role === "company_admin";

  async function load() {
    try {
      const p = await api<Profile>("/profile");
      setProfile(p);
      setPhone(p.company.phone ?? "");
      setContactEmail(p.company.contactEmail ?? "");
      setAddressLine(p.company.addressLine ?? "");
      setTownship(p.company.township ?? "");
      setCity(p.company.city ?? "");
      setRegion(p.company.region ?? "");
      setFullName(p.me.fullName ?? "");
      setMyPhone(p.me.phone ?? "");
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function saveCompany() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/profile/company", {
        method: "PATCH",
        body: {
          // Empty input clears the field rather than being ignored.
          phone: phone.trim() || null,
          contactEmail: contactEmail.trim() || null,
          addressLine: addressLine.trim() || null,
          township: township.trim() || null,
          city: city.trim() || null,
          region: region.trim() || null,
        },
      });
      setNotice(t("profile.companySaved"));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveMe() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/profile/me", {
        method: "PATCH",
        body: { fullName: fullName.trim(), phone: myPhone.trim() || null },
      });
      setNotice(t("profile.personalSaved"));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return null;

  return (
    <>
      <PageHeader title={t("profile.title")} subtitle={t("profile.subtitle")} />

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}

      <Stack spacing={3}>
        {/* Company identity — read only */}
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Typography variant="subtitle1">{t("profile.companyIdentity")}</Typography>
                <StatusChip status={profile.company.status} />
              </Stack>

              <Alert severity="info" icon={false}>
                {t("profile.lockedExplainer")}
              </Alert>

              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={3}
                useFlexGap
                flexWrap="wrap"
              >
                <LockedField
                  label={t("profile.legalName")}
                  value={profile.company.legalName}
                  reason={t("profile.lockedVerified")}
                />
                <LockedField
                  label={t("profile.registrationNumber")}
                  value={profile.company.registrationNumber}
                  reason={t("profile.lockedVerified")}
                />
                <LockedField
                  label={t("profile.plan")}
                  value={profile.company.plan}
                  reason={t("profile.lockedBilling")}
                />
              </Stack>

              {profile.company.registrationVerifiedAt && (
                <Typography variant="caption" color="text.secondary">
                  {t("profile.verifiedOn", {
                    date: new Date(profile.company.registrationVerifiedAt).toLocaleDateString(),
                  })}
                </Typography>
              )}
            </Stack>
          </CardContent>
        </Card>

        {/* Company contact details — editable by admins */}
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1">{t("profile.companyContact")}</Typography>
              {!isAdmin && <Alert severity="info">{t("profile.adminOnly")}</Alert>}

              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  label={t("profile.phone")}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={!isAdmin}
                  fullWidth
                  placeholder="09xxxxxxxxx"
                />
                <TextField
                  label={t("profile.contactEmail")}
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  disabled={!isAdmin}
                  fullWidth
                  helperText={t("profile.contactEmailHint")}
                />
              </Stack>

              <TextField
                label={t("profile.address")}
                value={addressLine}
                onChange={(e) => setAddressLine(e.target.value)}
                disabled={!isAdmin}
                fullWidth
                multiline
                minRows={2}
              />

              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  label={t("profile.township")}
                  value={township}
                  onChange={(e) => setTownship(e.target.value)}
                  disabled={!isAdmin}
                  fullWidth
                />
                <TextField
                  label={t("profile.city")}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  disabled={!isAdmin}
                  fullWidth
                />
                <TextField
                  label={t("profile.region")}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  disabled={!isAdmin}
                  fullWidth
                />
              </Stack>

              {isAdmin && (
                <Box>
                  <Button variant="contained" disabled={busy} onClick={saveCompany}>
                    {t("profile.saveCompany")}
                  </Button>
                </Box>
              )}
            </Stack>
          </CardContent>
        </Card>

        {/* The signed-in person */}
        <Card>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1">{t("profile.yourDetails")}</Typography>

              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField
                  label={t("profile.fullName")}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  fullWidth
                />
                <TextField
                  label={t("profile.phone")}
                  value={myPhone}
                  onChange={(e) => setMyPhone(e.target.value)}
                  fullWidth
                  placeholder="09xxxxxxxxx"
                />
              </Stack>

              <LockedField
                label={t("profile.loginEmail")}
                value={profile.me.email ?? "—"}
                reason={t("profile.lockedEmail")}
              />

              {/* The identity the company was verified against. Correcting it
                  is a re-verification, not a profile edit. */}
              <LockedField
                label={t("profile.nationalId")}
                value={profile.me.nationalId ?? "—"}
                reason={t("profile.lockedNationalId")}
              />

              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  {t("profile.role")}: {profile.me.role}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    profile.me.mfaEnabled ? t("profile.mfaOn") : t("profile.mfaOff")
                  }
                  color={profile.me.mfaEnabled ? "success" : "default"}
                />
              </Stack>

              <Box>
                <Button
                  variant="contained"
                  disabled={busy || fullName.trim().length === 0}
                  onClick={saveMe}
                >
                  {t("profile.savePersonal")}
                </Button>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        {/* Who else has access */}
        <Card>
          <CardContent>
            <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
              {t("profile.teamAccess")}
            </Typography>
            <Divider sx={{ mb: 1 }} />
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("profile.fullName")}</TableCell>
                  <TableCell>{t("profile.loginEmail")}</TableCell>
                  <TableCell>{t("profile.role")}</TableCell>
                  <TableCell>{t("common.status")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {profile.users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.fullName}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.role}</TableCell>
                    <TableCell>
                      <StatusChip status={u.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Stack>
    </>
  );
}
