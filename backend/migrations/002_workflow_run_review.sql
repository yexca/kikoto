CREATE TABLE workflow_run_review (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'reviewed',
  note TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workflow_run_id, user_id)
);

CREATE INDEX idx_workflow_run_review_run
  ON workflow_run_review(workflow_run_id);

CREATE INDEX idx_workflow_run_review_user
  ON workflow_run_review(user_id, reviewed_at);
