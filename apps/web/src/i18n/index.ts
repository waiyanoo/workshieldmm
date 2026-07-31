import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import my from "./locales/my.json";
import { reviewedWorkflowTranslations as reviewed } from "./reviewedWorkflowTranslations";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "my", label: "မြန်မာ" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

const STORAGE_KEY = "hyper.lang";

export function storedLanguage(): LanguageCode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "my" || saved === "en" ? saved : "en";
}

export function applyLanguage(code: LanguageCode): void {
  localStorage.setItem(STORAGE_KEY, code);
  document.documentElement.lang = code;
  void i18next.changeLanguage(code);
}

const myTranslation = {
  ...my,
  ...reviewed.my,
  app: { ...my.app, ...reviewed.my.app },
  auth: { ...my.auth, ...reviewed.my.auth },
  common: { ...my.common, ...reviewed.my.common },
  register: { ...my.register, ...reviewed.my.register },
  verifications: { ...my.verifications, ...reviewed.my.verifications },
  documents: { ...my.documents, ...reviewed.my.documents },
  reports: { ...my.reports, ...reviewed.my.reports },
  access: { ...my.access, ...reviewed.my.access },
};

const enTranslation = {
  ...en,
  ...reviewed.en,
  register: { ...en.register, ...reviewed.en.register },
  verifications: { ...en.verifications, ...reviewed.en.verifications },
  documents: { ...en.documents, ...reviewed.en.documents },
  reports: { ...en.reports, ...reviewed.en.reports },
  access: { ...en.access, ...reviewed.en.access },
};

void i18next.use(initReactI18next).init({
  resources: {
    en: { translation: enTranslation },
    my: { translation: myTranslation },
  },
  lng: storedLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  react: {
    // <Trans> only passes through a fixed set of inline tags; `b` is not in the
    // default list, so a message containing <b> rendered the tag as literal
    // text. Adding it keeps the emphasis working without a components map at
    // every call site.
    transKeepBasicHtmlNodesFor: ["br", "strong", "i", "p", "b", "em"],
  },
  returnEmptyString: false,
});

export default i18next;
