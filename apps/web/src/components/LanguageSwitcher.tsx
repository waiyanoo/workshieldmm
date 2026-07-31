/**
 * Language toggle.
 *
 * Lives in the sidebar footer, next to sign-out, so it is reachable from every
 * screen including the ones a confused user lands on. Each option is written in
 * its own language — someone who cannot read English cannot be expected to find
 * "Burmese" in an English list.
 */
import { useState } from "react";
import { IconButton, Menu, MenuItem, Tooltip } from "@mui/material";
import TranslateIcon from "@mui/icons-material/Translate";
import { useTranslation } from "react-i18next";
import { applyLanguage, LANGUAGES, type LanguageCode } from "../i18n";

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  return (
    <>
      <Tooltip title={t("app.language")}>
        <IconButton
          size="small"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ color: "text.secondary", "&:hover": { color: "text.primary" } }}
        >
          <TranslateIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        {LANGUAGES.map((lang) => (
          <MenuItem
            key={lang.code}
            selected={i18n.language === lang.code}
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
