/**
 * Turning an API failure into something a Burmese-speaking user can read.
 *
 * The API returns English messages — it has no idea who is asking, and putting
 * translations behind the API would mean shipping every locale to the server.
 * What it does return is a stable `error.code`, so the client translates the
 * code and keeps the server's text only as a last resort.
 *
 * The fallback is deliberate: an untranslated English sentence is more useful
 * than a generic "something went wrong", even to someone reading Burmese. It
 * also means a new server-side error code degrades gracefully instead of
 * showing a blank.
 */
import i18next from "i18next";
import { ApiError } from "../api/client";

export function apiErrorMessage(err: unknown, fallbackKey = "errors.generic"): string {
  if (err instanceof ApiError) {
    const key = `errors.${err.code}`;
    const translated = i18next.t(key);
    // i18next echoes the key back when there is no entry for it.
    if (translated !== key) return translated;
    return err.message || i18next.t(fallbackKey);
  }
  return i18next.t(fallbackKey);
}
