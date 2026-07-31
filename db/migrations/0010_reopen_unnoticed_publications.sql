-- ===========================================================================
-- 0010_reopen_unnoticed_publications — finish what 0009 started.
--
-- 0009 reopened reports that had been published with NO notice at all, and
-- left the ones 0008 migrated out of 'notice_sent'/'disputed' alone on the
-- reasoning that "a notice did run for them". That reasoning was wrong on two
-- counts:
--
--   * A notice having been SENT is not the same as its response window having
--     CLOSED. 0008's bulk `UPDATE ... WHERE status IN ('notice_sent',
--     'disputed')` published reports whose window still had days to run, so
--     the named person's reply arrived — if at all — after other employers
--     could already read the report.
--   * Worse, reports in 'disputed' were force-published too. Those are cases
--     where the person actively contested the claim and the platform published
--     it anyway without ever answering them.
--
-- The publication rule is the three conditions the 0009 trigger enforces:
-- a notice was sent, its window has elapsed, and no dispute is unresolved.
-- Anything sitting in 'approved' that fails any of them was never entitled to
-- be there, so it comes back out. The trigger only fires on transitions INTO
-- 'approved', so it could not catch rows that were already there.
--
-- Both paths below make a report immediately invisible to other employers:
-- discovery and cross-company reads filter on status = 'approved'.
-- ===========================================================================

-- Contested and never answered → back to the re-review queue, so a reviewer
-- has to make a decision on the response before it can publish again.
UPDATE conduct_reports r
   SET status = 'disputed'
 WHERE r.status = 'approved'
   AND EXISTS (
     SELECT 1 FROM disputes d
      WHERE d.report_id = r.id AND d.resolved_at IS NULL
   );

-- Published mid-window → back under notice. The sweep will publish it once the
-- window it was always entitled to has actually run out.
UPDATE conduct_reports
   SET status      = 'notice_sent',
       expiry_date = NULL
 WHERE status = 'approved'
   AND notice_sent_at IS NOT NULL
   AND (response_window_ends_at IS NULL OR response_window_ends_at > now());

-- Guard: fail the migration rather than commit a database that still violates
-- the publication rule. Cheap to check, and it makes the invariant explicit for
-- anyone reading this file later.
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM conduct_reports r
   WHERE r.status = 'approved'
     AND (
       r.notice_sent_at IS NULL
       OR r.response_window_ends_at IS NULL
       OR r.response_window_ends_at > now()
       OR EXISTS (
         SELECT 1 FROM disputes d
          WHERE d.report_id = r.id AND d.resolved_at IS NULL
       )
     );
  IF bad > 0 THEN
    RAISE EXCEPTION '% published report(s) still fail the notice/window/dispute rule', bad;
  END IF;
END $$;
