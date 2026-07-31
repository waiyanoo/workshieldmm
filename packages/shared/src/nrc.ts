/**
 * Myanmar NRC parsing, formatting and normalisation.
 *
 * An NRC is four parts: `<state>/<township><type><6 digits>`, e.g.
 * `12/OUKAMA(N)123456`. This platform hashes the NRC to identify a subject
 * across companies, which makes the exact string load-bearing — two employers
 * entering the same person must produce the same bytes, or they create two
 * subjects and the cross-company history the product exists to surface silently
 * splits in half.
 *
 * Free-text entry cannot deliver that. `12/OUKAMA(N)123456`,
 * `12 / oukama (n) 123456` and `12/OuKaMa(N) 123456` are the same person and
 * three different hashes. So the string is composed from parts in the UI, and
 * normalised here on the way in regardless of which client sent it.
 *
 * NORMALISATION IS DELIBERATELY CONSERVATIVE. A string that does not parse as
 * an NRC is returned trimmed and otherwise untouched — exactly what the hashing
 * code did before this module existed. That matters because it means an NRC
 * already stored in canonical form keeps its hash: normalising is a no-op on
 * `12/OUKAMA(N)123456`. Only the sloppy variants move, and those are the ones
 * that were quietly creating duplicate subjects.
 */
import { NRC_TOWNSHIPS, type NrcTownship } from "./nrc.data";

export { NRC_TOWNSHIPS };
export type { NrcTownship };

/** State / region numbers that appear on an NRC. */
export const NRC_STATES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

/**
 * Citizenship type, the letter in brackets.
 *
 * Labelled by the Burmese letter printed on the card rather than an English
 * gloss: the letter is what the holder is looking at, and the glosses carry
 * legal meaning that is not this component's to summarise.
 */
export interface NrcType {
  code: string;
  labelMm: string;
}

export const NRC_TYPES: readonly NrcType[] = [
  { code: "N", labelMm: "နိုင်" },
  { code: "E", labelMm: "ဧည့်" },
  { code: "P", labelMm: "ပြု" },
  { code: "TH", labelMm: "သ" },
];

export interface NrcParts {
  /** 1-14 */
  state: number;
  /** Latin township code, upper case, e.g. "OUKAMA" */
  township: string;
  /** Citizenship type letter, upper case, e.g. "N" */
  type: string;
  /** Exactly 6 digits, as a string so leading zeros survive. */
  number: string;
}

/** The canonical rendering. Everything else normalises to this. */
export function formatNrc(parts: NrcParts): string {
  return `${parts.state}/${parts.township.toUpperCase()}(${parts.type.toUpperCase()})${parts.number}`;
}

/**
 * Pull an NRC apart, tolerating the ways people actually type them: any casing,
 * spaces anywhere, Burmese digits, and `[]`/`{}` in place of round brackets.
 *
 * Returns null when the string is not an NRC at all — the caller decides what
 * to do about that, and `normalizeNrc` deliberately leaves such strings alone.
 */
export function parseNrc(raw: string): NrcParts | null {
  if (!raw) return null;

  // Burmese digits to ASCII, so a card copied in Burmese numerals still parses.
  const ascii = raw.replace(/[၀-၉]/g, (d) =>
    String(d.charCodeAt(0) - 0x1040)
  );

  const compact = ascii
    .replace(/[\[{]/g, "(")
    .replace(/[\]}]/g, ")")
    .replace(/\s+/g, "")
    .toUpperCase();

  const m = /^(\d{1,2})\/([A-Z]+)\(([A-Z]{1,3})\)(\d{6})$/.exec(compact);
  if (!m) return null;

  const state = Number(m[1]);
  if (!NRC_STATES.includes(state)) return null;

  return { state, township: m[2]!, type: m[3]!, number: m[4]! };
}

/**
 * Canonical form for hashing.
 *
 * Anything that is not a recognisable NRC comes back trimmed and unchanged, so
 * this can be dropped in front of existing hashing without moving identifiers
 * that were already stored.
 */
export function normalizeNrc(raw: string): string {
  const parts = parseNrc(raw);
  return parts ? formatNrc(parts) : raw.trim();
}

/** Township codes for a state, or an empty list for an unknown state. */
export function townshipsForState(state: number): readonly NrcTownship[] {
  return NRC_TOWNSHIPS[state] ?? [];
}

/**
 * Whether a township code is one we have catalogued for that state.
 *
 * Used to WARN, never to block. The table is a snapshot of a list that changes
 * as townships are created and renamed, and refusing an NRC because our copy is
 * stale would turn a data-maintenance problem into a real person who cannot be
 * checked.
 */
export function isKnownTownship(state: number, township: string): boolean {
  const code = township.trim().toUpperCase();
  return townshipsForState(state).some((t) => t.code === code);
}
