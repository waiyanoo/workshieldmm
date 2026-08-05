-- The standalone review-board workflow was retired in 0011. Preserve existing
-- staff access by moving any legacy accounts to the normal reviewer role before
-- narrowing the database constraint.
UPDATE platform_users SET role = 'admin_reviewer' WHERE role = 'review_board';

ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS platform_users_role_check;
ALTER TABLE platform_users
  ADD CONSTRAINT platform_users_role_check
  CHECK (role IN ('super_admin', 'admin_reviewer'));
