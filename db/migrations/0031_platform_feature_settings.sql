-- Runtime feature controls. Rows are intentionally absent initially: the API
-- falls back to the existing environment variables until a Super Admin saves a
-- setting, so deploying this migration cannot unexpectedly enable or disable a
-- workflow.
CREATE TABLE platform_feature_settings (
  key text PRIMARY KEY CHECK (key IN ('tier_b', 'team_invites')),
  enabled boolean NOT NULL,
  updated_by uuid REFERENCES platform_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_feature_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_feature_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_feature_settings_read ON platform_feature_settings
  FOR SELECT USING (true);
CREATE POLICY platform_feature_settings_write ON platform_feature_settings
  FOR ALL USING (current_setting('app.user_type', true) = 'platform')
  WITH CHECK (current_setting('app.user_type', true) = 'platform');

GRANT SELECT, INSERT, UPDATE ON platform_feature_settings TO hyper_app;
