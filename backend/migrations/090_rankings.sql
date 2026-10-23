-- Rankings keep dated snapshots of provider and remote source popular lists.
-- Entries are catalog codes, never works: a pull records ranks and display
-- text and creates nothing in the library.

-- One tracked ranking, shared by every account. A DLsite list names a period
-- and optional release window; a remote source list names its source.
CREATE TABLE ranking_list (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('dlsite', 'remote_source')),
  file_source_id INTEGER REFERENCES file_source(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT '' CHECK(period IN ('', 'day', 'week', 'month')),
  release_window TEXT NOT NULL DEFAULT '' CHECK(release_window IN ('', '30d')),
  depth INTEGER NOT NULL DEFAULT 100 CHECK(depth BETWEEN 10 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  last_pulled_at TEXT,
  last_status TEXT NOT NULL DEFAULT '' CHECK(last_status IN ('', 'succeeded', 'failed', 'source_unavailable')),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (provider = 'dlsite' AND file_source_id IS NULL AND period <> '')
    OR (provider = 'remote_source' AND file_source_id IS NOT NULL AND period = '' AND release_window = '')
  )
);

CREATE UNIQUE INDEX idx_ranking_list_identity
  ON ranking_list(provider, COALESCE(file_source_id, 0), period, release_window);
CREATE INDEX idx_fk_ranking_list_file_source_id ON ranking_list(file_source_id);

-- One pull whose order differs from the list's previous snapshot.
CREATE TABLE ranking_snapshot (
  id INTEGER PRIMARY KEY,
  ranking_list_id INTEGER NOT NULL REFERENCES ranking_list(id) ON DELETE CASCADE,
  pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  workflow_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  item_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE INDEX idx_ranking_snapshot_list_pulled ON ranking_snapshot(ranking_list_id, pulled_at DESC, id DESC);
CREATE INDEX idx_fk_ranking_snapshot_workflow_run_id ON ranking_snapshot(workflow_run_id);

CREATE TABLE ranking_snapshot_item (
  snapshot_id INTEGER NOT NULL REFERENCES ranking_snapshot(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK(rank >= 1),
  primary_code TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, rank),
  UNIQUE(snapshot_id, primary_code)
);

CREATE INDEX idx_ranking_snapshot_item_code ON ranking_snapshot_item(primary_code);

-- Per list and code: the display text the ranking carries and statistics
-- derived from the snapshots, so a list page reads one row per item.
CREATE TABLE ranking_entry (
  ranking_list_id INTEGER NOT NULL REFERENCES ranking_list(id) ON DELETE CASCADE,
  primary_code TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  maker_name TEXT NOT NULL DEFAULT '',
  remote_work_id INTEGER NOT NULL DEFAULT 0,
  remote_cover_url TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  streak_started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  best_rank INTEGER NOT NULL,
  appearances INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ranking_list_id, primary_code)
);

-- The snapshot each account last looked at, per list.
CREATE TABLE user_ranking_state (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  ranking_list_id INTEGER NOT NULL REFERENCES ranking_list(id) ON DELETE CASCADE,
  seen_snapshot_id INTEGER REFERENCES ranking_snapshot(id) ON DELETE SET NULL,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, ranking_list_id)
);

CREATE INDEX idx_fk_user_ranking_state_list ON user_ranking_state(ranking_list_id);
CREATE INDEX idx_fk_user_ranking_state_snapshot ON user_ranking_state(seen_snapshot_id);
