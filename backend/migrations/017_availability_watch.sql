CREATE TABLE availability_watch (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL UNIQUE REFERENCES user_account(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK(interval_minutes BETWEEN 5 AND 10080),
  action TEXT NOT NULL DEFAULT 'monitor' CHECK(action IN ('monitor', 'track', 'fetch', 'track_fetch')),
  source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  exclude_extensions_json TEXT NOT NULL DEFAULT '["wav"]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE availability_watch_target (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES availability_watch(id) ON DELETE CASCADE,
  work_code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'monitoring' CHECK(state IN ('monitoring', 'ready', 'action_queued', 'completed', 'error', 'disabled')),
  next_check_at TEXT,
  last_checked_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  available_source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  availability_epoch INTEGER NOT NULL DEFAULT 0,
  track_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  fetch_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(watch_id, work_code)
);

CREATE INDEX idx_availability_watch_target_due
ON availability_watch_target(active, state, next_check_at, id);

CREATE TABLE availability_watch_outbox (
  id INTEGER PRIMARY KEY,
  target_id INTEGER NOT NULL REFERENCES availability_watch_target(id) ON DELETE CASCADE,
  availability_epoch INTEGER NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(target_id, availability_epoch, action)
);

CREATE INDEX idx_availability_watch_outbox_pending
ON availability_watch_outbox(status, next_attempt_at, id);
