UPDATE workflow_definition
SET description = 'Discover local works and synchronize local source presence.',
    definition_json = '{"nodes":[{"id":"select","type":"select_local_source","displayName":"Select local source"},{"id":"discover","type":"discover_local_files","displayName":"Discover files"},{"id":"match","type":"match_works","displayName":"Match works"},{"id":"sync","type":"sync_file_locations","displayName":"Sync locations"}]}'
WHERE code = 'local_library_scan';

UPDATE workflow_trigger
SET config_json = '{"followUpRun":false}',
    updated_at = CURRENT_TIMESTAMP
WHERE workflow_definition_id = (
    SELECT id FROM workflow_definition WHERE code = 'local_library_scan'
  )
  AND trigger_type IN ('startup', 'schedule', 'filesystem_event');
