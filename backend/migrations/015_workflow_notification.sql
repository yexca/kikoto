CREATE TABLE workflow_notification (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  status TEXT NOT NULL,
  work_id INTEGER REFERENCES work(id) ON DELETE SET NULL,
  work_code TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  dismissed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workflow_run_id, notification_type)
);

CREATE INDEX idx_workflow_notification_user_active
  ON workflow_notification(user_id, dismissed_at, created_at DESC, id DESC);
