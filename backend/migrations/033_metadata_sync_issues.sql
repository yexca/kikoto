CREATE TABLE metadata_sync_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE metadata_sync_attempt_run (
  attempt_id INTEGER NOT NULL REFERENCES metadata_sync_attempt(id) ON DELETE CASCADE,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  PRIMARY KEY(attempt_id, workflow_run_id)
);
CREATE INDEX idx_metadata_sync_attempt_run_run ON metadata_sync_attempt_run(workflow_run_id, attempt_id);

CREATE TABLE metadata_sync_attempt_work (
  attempt_id INTEGER NOT NULL REFERENCES metadata_sync_attempt(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK(component IN ('metadata', 'cover')),
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'unavailable')),
  PRIMARY KEY(attempt_id, work_id, provider_id, component)
);

-- Current recovery state is shared by a work/provider; workflow history and
-- user review records retain their original ownership and execution results.
CREATE TABLE work_metadata_sync_state (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  component TEXT NOT NULL CHECK(component IN ('metadata', 'cover')),
  attempt_id INTEGER NOT NULL REFERENCES metadata_sync_attempt(id),
  last_success_attempt_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed', 'unavailable')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, provider_id, component)
);
CREATE INDEX idx_work_metadata_sync_state_pending ON work_metadata_sync_state(status, checked_at, work_id, provider_id);

-- Existing structured unavailable observations can be recovered without
-- interpreting private free-text errors in historical workflow logs.
INSERT INTO metadata_sync_attempt (id) VALUES (1);
INSERT INTO work_metadata_sync_state
  (work_id, provider_id, component, attempt_id, status, failure_count, first_failed_at, checked_at)
SELECT work_id, provider_id, 'metadata', 1, 'unavailable', 1, checked_at, checked_at
FROM work_metadata_provider_state WHERE status = 'not_found';
INSERT INTO metadata_sync_attempt_work (attempt_id, work_id, provider_id, component, status)
SELECT 1, work_id, provider_id, component, status FROM work_metadata_sync_state;
