/**
 * Subject-identifier hashing.
 *
 * A national ID is NEVER stored raw (§3 Data model, §5 Data minimization). We
 * store an HMAC keyed by a server-side pepper, so a database leak alone can't
 * be rainbow-tabled back to real IDs, and the same ID always maps to the same
 * subject for de-duplication.
 */
import { createHmac } from "node:crypto";
import { normalizeNrc } from "@hyper/shared";
import { env } from "../config/env";

/**
 * The ID is normalised to its canonical NRC form before hashing.
 *
 * Without it, `12/OUKAMA(N)123456` and `12 / oukama (n) 123456` are the same
 * person and two different subjects — which quietly halves the cross-company
 * history this platform exists to surface. Normalising at the hash is the one
 * place every path goes through, so no caller can bypass it.
 *
 * A string that is not a recognisable NRC is only trimmed, exactly as before,
 * so identifiers already stored do not move.
 */
export function hashNationalId(nationalId: string): string {
  return createHmac("sha256", env.SUBJECT_ID_PEPPER)
    .update(normalizeNrc(nationalId))
    .digest("hex");
}
