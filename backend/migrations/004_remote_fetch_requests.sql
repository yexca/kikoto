CREATE TABLE remote_fetch_request (
  request_id TEXT PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  work_code TEXT NOT NULL,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_remote_fetch_request_run
  ON remote_fetch_request(workflow_run_id);

CREATE INDEX idx_remote_fetch_request_created_at
  ON remote_fetch_request(created_at);
