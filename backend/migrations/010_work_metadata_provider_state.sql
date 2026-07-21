CREATE TABLE work_metadata_provider_state (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('available', 'not_found')),
  message TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, provider_id)
);

CREATE INDEX idx_work_metadata_provider_state_provider_status
  ON work_metadata_provider_state(provider_id, status, work_id);

INSERT INTO work_metadata_provider_state (work_id, provider_id, status, checked_at, updated_at)
SELECT snapshot.work_id, snapshot.provider_id, 'available', MAX(snapshot.fetched_at), CURRENT_TIMESTAMP
FROM metadata_snapshot AS snapshot
INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
WHERE snapshot.work_id IS NOT NULL AND provider.code = 'dlsite'
GROUP BY snapshot.work_id, snapshot.provider_id;
