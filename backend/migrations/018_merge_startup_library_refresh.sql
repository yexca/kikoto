UPDATE workflow_definition
SET display_name = 'Scan local library',
    description = 'Discover local works, sync local source presence, and synchronize missing metadata.',
    definition_json = '{"nodes":[{"id":"select","type":"select_local_source","displayName":"Select local source"},{"id":"discover","type":"discover_local_files","displayName":"Discover files"},{"id":"match","type":"match_works","displayName":"Match works"},{"id":"sync","type":"sync_file_locations","displayName":"Sync locations"},{"id":"metadata","type":"sync_metadata","displayName":"Sync metadata"}]}'
WHERE code = 'local_library_scan';

DELETE FROM workflow_trigger
WHERE workflow_definition_id = (
    SELECT id FROM workflow_definition WHERE code = 'startup_library_refresh'
  )
  AND trigger_type = 'startup'
  AND EXISTS (
    SELECT 1
    FROM workflow_trigger AS local_trigger
    INNER JOIN workflow_definition AS local_definition
      ON local_definition.id = local_trigger.workflow_definition_id
    WHERE local_definition.code = 'local_library_scan'
      AND local_trigger.trigger_type = 'startup'
  );

UPDATE workflow_trigger
SET workflow_definition_id = (
      SELECT id FROM workflow_definition WHERE code = 'local_library_scan'
    ),
    display_name = CASE
      WHEN display_name = 'Startup library refresh' THEN 'Startup local library scan'
      ELSE display_name
    END,
    config_json = '{}',
    updated_at = CURRENT_TIMESTAMP
WHERE workflow_definition_id = (
  SELECT id FROM workflow_definition WHERE code = 'startup_library_refresh'
);

DELETE FROM workflow_definition
WHERE code = 'startup_library_refresh';
