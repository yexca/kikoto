CREATE TABLE IF NOT EXISTS person_merge_review (
  id INTEGER PRIMARY KEY,
  target_person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  source_person_id INTEGER NOT NULL,
  target_name TEXT NOT NULL,
  source_name TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'merged',
  undone_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_person_merge_review_target
  ON person_merge_review(target_person_id, status, created_at);
