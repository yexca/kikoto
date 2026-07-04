UPDATE workflow_trigger
SET enabled = 1,
    updated_at = CURRENT_TIMESTAMP
WHERE trigger_type = 'startup'
  AND workflow_definition_id IN (
    SELECT id FROM workflow_definition WHERE code = 'local_library_scan'
  );

INSERT INTO workflow_trigger (
  workflow_definition_id,
  trigger_type,
  display_name,
  enabled,
  schedule_json,
  config_json
)
SELECT
  id,
  'startup',
  'Startup local library scan',
  1,
  '{"type":"startup"}',
  '{"reason":"system_startup"}'
FROM workflow_definition
WHERE code = 'local_library_scan'
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_trigger
    WHERE workflow_trigger.workflow_definition_id = workflow_definition.id
      AND workflow_trigger.trigger_type = 'startup'
  );
