-- kikoto:foreign_keys=off
-- The contributor role sits between user and admin. SQLite cannot change a
-- CHECK constraint in place, so user_account is rebuilt. Every account keeps
-- its id, so sessions, credentials, and personal data that reference it stay
-- attached; the manager runs this file with foreign key enforcement off so
-- dropping the old table does not cascade, then checks every reference.
CREATE TABLE user_account_next (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'contributor', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ui_locale TEXT NOT NULL DEFAULT 'auto'
    CHECK(ui_locale IN ('auto', 'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'))
);

INSERT INTO user_account_next (id, username, display_name, role, enabled, created_at, updated_at, ui_locale)
SELECT id, username, display_name, role, enabled, created_at, updated_at, ui_locale
FROM user_account;

DROP TABLE user_account;
ALTER TABLE user_account_next RENAME TO user_account;
