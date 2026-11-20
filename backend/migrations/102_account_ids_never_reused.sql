-- kikoto:foreign_keys=off
-- An account id names one account for as long as the database lives. Ids are
-- never handed out again, so the workflow runs a deleted account requested, and
-- anything else that kept its id, never attach to an account created later.
-- Every account keeps its id; the manager runs this file with foreign key
-- enforcement off so dropping the old table does not cascade into sessions,
-- credentials, and personal data, then checks every reference.

CREATE TABLE user_account_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- An account deleted before this migration may still own workflow runs that
-- name its id. Those ids stay retired too.
INSERT INTO sqlite_sequence (name, seq)
SELECT 'user_account', 0
WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'user_account')
  AND EXISTS (SELECT 1 FROM workflow_run WHERE json_valid(input_json)
    AND CAST(json_extract(input_json, '$.requested_by_user_id') AS INTEGER) > 0);

UPDATE sqlite_sequence
SET seq = MAX(seq, COALESCE((
  SELECT MAX(CAST(json_extract(input_json, '$.requested_by_user_id') AS INTEGER))
  FROM workflow_run
  WHERE json_valid(input_json)
), 0))
WHERE name = 'user_account';
