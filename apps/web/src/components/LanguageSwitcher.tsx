/**
 * Language toggle.
 *
 * Lives in the sidebar footer, next to sign-out, so it is reachable from every
 * screen including the ones a confused user lands on. Each option is written in
 * its own language — someone who cannot read English cannot be expected to find
 * "Burmese" in an English list.
 */
import { useState } from "react";
import { Button, Menu, MenuItem, Tooltip } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useTranslation } from "react-i18next";
import { applyLanguage, LANGUAGES, type LanguageCode } from "../i18n";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const currentCode = (i18n.resolvedLanguage ?? i18n.language).split("-")[0];
  const current = LANGUAGES.find((language) => language.code === currentCode) ?? LANGUAGES[0];

  return (
    <>
      <Tooltip title={t("app.language")}>
        <Button
          size="small"
          onClick={(e) => setAnchor(e.currentTarget)}
          endIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          sx={{
            color: "text.secondary",
            minWidth: 0,
            px: { xs: 0.75, sm: 1 },
            fontSize: 13,
            fontWeight: 700,
            textTransform: "none",
            whiteSpace: "nowrap",
            "&:hover": { color: "text.primary" },
          }}
        >
          {current.label}
        </Button>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {LANGUAGES.map((lang) => (
          <MenuItem
            key={lang.code}
            selected={currentCode === lang.code}
            onClick={() => {
              applyLanguage(lang.code as LanguageCode);
              setAnchor(null);
            }}
          >
            {lang.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
