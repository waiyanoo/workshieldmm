/**
 * The declarations a company accepts, and the exact words of each version.
 *
 * `company_declarations` (0028) stores a kind and a version. That record is
 * only worth something if the version can be resolved back to the wording it
 * names — otherwise it says a company agreed to "2026-08" and nobody can say
 * what 2026-08 was. So the text lives here, archived by version, and old
 * entries are never edited: a record pointing at a version must still find the
 * words that were on screen when it was written.
 *
 * This is deliberately NOT in the locale files, unlike every other string in
 * the product. Interface text can be reworded freely; these two paragraphs are
 * the thing being agreed to, and editing one silently would change the meaning
 * of records already written. Keeping them here puts the wording and its
 * version in the same file, and declarations.test.ts pins each text with a
 * digest so an edit fails the build rather than passing unnoticed.
 *
 * To change a declaration: add a new version below, leave the old one alone,
 * and point CURRENT at it. Both languages are required — a version that exists
 * in only one language cannot be shown to half the users it applies to.
 */

export type DeclarationKind = "registration" | "report_submission";

export interface DeclarationText {
  en: string;
  my: string;
}

/**
 * Every version ever offered, newest last. Entries are append-only.
 *
 * 2026-08 existed in English only: the Burmese locale carried no declaration
 * text, so Burmese-speaking users were shown the English fallback. 2026-08.2
 * is that same meaning with a Burmese translation added — a new version rather
 * than a correction of the old one, because what a user reads changed, and
 * records already written truthfully say they read the English-only text.
 */
export const DECLARATION_ARCHIVE: Record<DeclarationKind, Record<string, DeclarationText>> = {
  registration: {
    "2026-08": {
      en:
        "I confirm that this company’s registration details are accurate and that I am " +
        "authorised to register it on WorkShield MM. I agree to the platform terms, privacy " +
        "notice, and responsible use of personal data.",
      // Not translated at the time. Recorded as the English text so the archive
      // answers honestly for records that name this version.
      my:
        "I confirm that this company’s registration details are accurate and that I am " +
        "authorised to register it on WorkShield MM. I agree to the platform terms, privacy " +
        "notice, and responsible use of personal data.",
    },
    "2026-08.2": {
      en:
        "I confirm that this company’s registration details are accurate and that I am " +
        "authorised to register it on WorkShield MM. I agree to the platform terms, privacy " +
        "notice, and responsible use of personal data.",
      my:
        "ဤကုမ္ပဏီ၏ မှတ်ပုံတင် အချက်အလက်များ မှန်ကန်ကြောင်းနှင့် WorkShield MM တွင် " +
        "မှတ်ပုံတင်ရန် ကျွန်ုပ်တွင် အခွင့်အာဏာ ရှိကြောင်း အတည်ပြုပါသည်။ ပလက်ဖောင်း " +
        "စည်းမျဉ်းများ၊ ကိုယ်ရေးအချက်အလက် အသိပေးချက်နှင့် ပုဂ္ဂိုလ်ရေး အချက်အလက်များကို " +
        "တာဝန်ယူမှုရှိစွာ အသုံးပြုရန် သဘောတူပါသည်။",
    },
  },
  report_submission: {
    "2026-08": {
      en:
        "I confirm that this report is accurate to the best of our knowledge, that the evidence " +
        "is genuine and relevant, and that I am authorised to submit it. I understand that false " +
        "or misleading reports may result in account action and the report may be withdrawn " +
        "after review.",
      my:
        "I confirm that this report is accurate to the best of our knowledge, that the evidence " +
        "is genuine and relevant, and that I am authorised to submit it. I understand that false " +
        "or misleading reports may result in account action and the report may be withdrawn " +
        "after review.",
    },
    "2026-08.2": {
      en:
        "I confirm that this report is accurate to the best of our knowledge, that the evidence " +
        "is genuine and relevant, and that I am authorised to submit it. I understand that false " +
        "or misleading reports may result in account action and the report may be withdrawn " +
        "after review.",
      my:
        "ဤအစီရင်ခံစာသည် ကျွန်ုပ်တို့ သိရှိသမျှအရ မှန်ကန်ကြောင်း၊ သက်သေအထောက်အထားများ " +
        "စစ်မှန်၍ သက်ဆိုင်မှုရှိကြောင်း၊ တင်သွင်းရန် ကျွန်ုပ်တွင် အခွင့်အာဏာ ရှိကြောင်း " +
        "အတည်ပြုပါသည်။ မမှန်ကန်သော သို့မဟုတ် လွဲမှားစေသော အစီရင်ခံစာများသည် အကောင့်အပေါ် " +
        "အရေးယူမှု ဖြစ်စေနိုင်ပြီး စစ်ဆေးပြီးနောက် အစီရင်ခံစာကို ရုပ်သိမ်းနိုင်ကြောင်း " +
        "နားလည်ပါသည်။",
    },
  },
};

/** The version currently on offer for each declaration. */
export const DECLARATION_VERSIONS = {
  registration: "2026-08.2",
  report_submission: "2026-08.2",
} as const satisfies Record<DeclarationKind, string>;

export function currentDeclarationVersion(kind: DeclarationKind): string {
  return DECLARATION_VERSIONS[kind];
}

/**
 * The words of a given version, in a given language.
 *
 * Returns null for a version that is not in the archive rather than guessing:
 * a caller asking about wording that was never offered has a problem worth
 * seeing, not one worth papering over with the current text.
 */
export function declarationText(
  kind: DeclarationKind,
  version: string,
  locale: string
): string | null {
  const entry = DECLARATION_ARCHIVE[kind][version];
  if (!entry) return null;
  return locale.startsWith("my") ? entry.my : entry.en;
}

/** The words currently on offer — what the acceptance screen must show. */
export function currentDeclarationText(kind: DeclarationKind, locale: string): string {
  // Non-null by construction: the test suite asserts every current version is
  // present in the archive.
  return declarationText(kind, currentDeclarationVersion(kind), locale)!;
}
