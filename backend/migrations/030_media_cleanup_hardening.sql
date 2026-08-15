ALTER TABLE work_folder_location
  ADD COLUMN cleanup_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL;

CREATE INDEX idx_work_folder_location_cleanup
  ON work_folder_location(cleanup_run_id, state, id);

-- Older databases recorded the local root only on source presence. Preserve
-- that information as an explicit folder identity before cleanup starts using
-- the folder table.
INSERT INTO work_folder_location (
  work_id, file_source_id, root_path, role, state, is_primary,
  last_scanned_at, created_at, updated_at
)
SELECT
  presence.work_id,
  presence.file_source_id,
  TRIM(REPLACE(presence.source_url, char(92), '/'), '/'),
  'external',
  CASE WHEN presence.availability = 'available' THEN 'active' ELSE 'ignored' END,
  1,
  presence.last_checked_at,
  COALESCE(presence.created_at, CURRENT_TIMESTAMP),
  COALESCE(presence.updated_at, CURRENT_TIMESTAMP)
FROM work_source_presence AS presence
WHERE presence.presence_type = 'local'
  AND TRIM(presence.source_url) <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM work_folder_location AS folder
    WHERE folder.file_source_id = presence.file_source_id
      AND folder.root_path = TRIM(REPLACE(presence.source_url, char(92), '/'), '/')
  );
