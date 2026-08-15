-- Store the interface language independently for each user account. `auto`
-- follows the client browser language and remains the default for existing users.
ALTER TABLE user_account
  ADD COLUMN ui_locale TEXT NOT NULL DEFAULT 'auto'
  CHECK(ui_locale IN ('auto', 'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'));
