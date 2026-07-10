ALTER TABLE remote_fetch_manifest_item ADD COLUMN remote_source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL;
ALTER TABLE remote_fetch_manifest_item ADD COLUMN source_path TEXT NOT NULL DEFAULT '';
ALTER TABLE remote_fetch_manifest_item ADD COLUMN original_target_path TEXT NOT NULL DEFAULT '';
ALTER TABLE remote_fetch_manifest_item ADD COLUMN resolution TEXT NOT NULL DEFAULT 'auto';

CREATE INDEX idx_remote_fetch_manifest_item_source
  ON remote_fetch_manifest_item(manifest_id, remote_source_id, state, id);

ALTER TABLE workflow_job ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_job ADD COLUMN recoverable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_job ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE workflow_job ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_job ADD COLUMN available_at TEXT;

CREATE INDEX idx_workflow_job_recovery
  ON workflow_job(status, recoverable, available_at, heartbeat_at, id);

INSERT INTO work_source_presence (
  work_id, file_source_id, presence_type, remote_code,
  availability, raw_json, last_checked_at, updated_at
)
SELECT DISTINCT
  manifest.work_id,
  manifest.remote_source_id,
  'tracked',
  manifest.edition_code,
  'available',
  json_object('source', 'fetch_manifest_migration', 'edition_code', manifest.edition_code),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM remote_fetch_manifest AS manifest
WHERE manifest.state = 'completed'
ON CONFLICT(work_id, file_source_id, presence_type) DO UPDATE SET
  remote_code = CASE WHEN excluded.remote_code <> '' THEN excluded.remote_code ELSE work_source_presence.remote_code END,
  availability = 'available',
  updated_at = CURRENT_TIMESTAMP;

DELETE FROM media_file_location
WHERE location_type = 'remote_stream'
  AND EXISTS (
    SELECT 1
    FROM media_item AS item
    INNER JOIN remote_fetch_manifest AS manifest ON manifest.work_id = item.work_id
    WHERE item.id = media_file_location.media_item_id
      AND manifest.remote_source_id = media_file_location.file_source_id
      AND manifest.state = 'completed'
  );
