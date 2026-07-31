/**
 * Formatting for calendar dates versus instants.
 *
 * These are different kinds of value and mixing them is how a date of birth
 * ends up a day out. A birthday, or the day a subscription period starts, is a
 * date on a calendar — it has no time and no timezone. A created-at timestamp
 * is a moment on a clock, and does.
 *
 * `new Date("1994-02-17")` parses as UTC midnight, so `toLocaleDateString()`
 * renders it as the 16th anywhere west of Greenwich. Splitting the string and
 * building the Date from local parts keeps the day the API sent.
 */

/** Format a "YYYY-MM-DD" calendar date without any timezone conversion. */
export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return "—";

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) {
    // Not a plain date — fall back to instant formatting rather than showing
    // a raw string to the user.
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
  }

  const [, year, month, day] = match;
  // Local construction: no UTC round-trip, so the day cannot move.
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString();
}

/** Format a genuine instant (timestamptz) in the viewer's timezone. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}
