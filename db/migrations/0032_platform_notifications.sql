-- ===========================================================================
-- 0032_platform_notifications — notifications addressed to platform staff.
--
-- Until now every notification was about a company and read by that company.
-- The work that has no owner is the platform's own: a payment sitting
-- unconfirmed is money a customer has already sent, and a company that has just
-- finished uploading its documents is invisible inside a "companies pending"
-- count. Neither is on any queue anyone watches.
--
-- Addressed by ROLE GROUP rather than to a person. These are shared work items:
-- once one reviewer has dealt with a payment the others do not need telling,
-- so a single row with one read state is the honest model. Two groups, matching
-- the two role guards already in the API:
--
--   platform_review — anyone who can act on the review and payment queues
--                     (admin_reviewer + super_admin)
--   platform_admin  — super_admin only
--
-- company_id stays populated on a platform notice ABOUT a company: it is real
-- information, and it keeps the insert inside the company's own RLS context
-- when a company action is what raised it.
-- ===========================================================================

ALTER TABLE notifications ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE notifications
  ADD COLUMN audience text NOT NULL DEFAULT 'company'
    CHECK (audience IN ('company', 'platform_review', 'platform_admin'));

-- A company notice must name its company. A platform notice may name one (it
-- is usually about a company) but must never be addressed to an individual
-- company user, because company_users and platform staff are different people.
ALTER TABLE notifications
  ADD CONSTRAINT notification_addressee CHECK (
    (audience = 'company' AND company_id IS NOT NULL)
    OR (audience <> 'company' AND user_id IS NULL)
  );

-- Lets a repeatable job raise a notice at most once. The sweep that warns about
-- a promotion ending runs every fifteen minutes; without this it would warn
-- every fifteen minutes.
ALTER TABLE notifications ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_notifications_platform ON notifications(audience, created_at DESC)
  WHERE audience <> 'company';
-- The unread badge, which runs on every page load for platform staff.
CREATE INDEX idx_notifications_platform_unread ON notifications(audience)
  WHERE audience <> 'company' AND read_at IS NULL;

-- Companies must not read platform notices about themselves. The previous
-- policy matched on company_id alone, which would now expose exactly that.
DROP POLICY IF EXISTS notifications_scope ON notifications;
CREATE POLICY notifications_scope ON notifications
  USING (
    app_is_platform()
    OR app_user_type() = 'system'
    OR (audience = 'company' AND company_id = app_company_id())
  )
  -- Writes stay as they were: a company context may only write rows for its own
  -- company, which is precisely the legitimate case (a company action raising a
  -- platform notice about that company). Platform notices with no company at
  -- all are raised by the system context.
  WITH CHECK (
    app_is_platform()
    OR app_user_type() = 'system'
    OR company_id = app_company_id()
  );
