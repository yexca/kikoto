-- Adds the after_workflow trigger type, which starts an operation after its
-- upstream scan finds something new, and moves the automation that used to
-- start the downstream operations onto it:
--   * a local scan trigger's followUpRun becomes the metadata sync's After
--     trigger, and the option leaves every local scan trigger;
--   * the file index's and media details' Startup triggers become their After
--     triggers, keeping whether they are on.
-- Runs already queued keep the trigger type they were queued with.

DROP TRIGGER IF EXISTS validate_workflow_trigger_insert;
DROP TRIGGER IF EXISTS validate_workflow_trigger_update;

CREATE TRIGGER validate_workflow_trigger_insert
BEFORE INSERT ON workflow_trigger
BEGIN
  SELECT CASE
    WHEN NEW.trigger_type NOT IN ('startup', 'schedule', 'filesystem_event', 'source_poll', 'after_workflow')
      THEN RAISE(ABORT, 'invalid workflow trigger type')
  END;
END;

CREATE TRIGGER validate_workflow_trigger_update
BEFORE UPDATE ON workflow_trigger
BEGIN
  SELECT CASE
    WHEN NEW.trigger_type NOT IN ('startup', 'schedule', 'filesystem_event', 'source_poll', 'after_workflow')
      THEN RAISE(ABORT, 'invalid workflow trigger type')
  END;
END;

-- A metadata sync after each scan that adds works, on when any local scan
-- trigger that asked for a follow-up run was on. '{}' is the default sync:
-- every work missing metadata, from DLsite.
INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
SELECT metadata.id, 'after_workflow', 'Metadata after scan', MAX(scan_trigger.enabled), '{"after":"local_library_scan"}', '{}'
FROM workflow_definition AS metadata
INNER JOIN workflow_definition AS scan ON scan.code = 'local_library_scan'
INNER JOIN workflow_trigger AS scan_trigger ON scan_trigger.workflow_definition_id = scan.id
WHERE metadata.code = 'metadata_sync'
  AND json_valid(scan_trigger.config_json)
  AND json_extract(scan_trigger.config_json, '$.followUpRun') = 1
  AND NOT EXISTS (
    SELECT 1 FROM workflow_trigger AS existing
    WHERE existing.workflow_definition_id = metadata.id AND existing.trigger_type = 'after_workflow'
  )
GROUP BY metadata.id;

UPDATE workflow_trigger
SET config_json = json_remove(config_json, '$.followUpRun'), updated_at = CURRENT_TIMESTAMP
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'local_library_scan')
  AND json_valid(config_json)
  AND json_type(config_json, '$.followUpRun') IS NOT NULL;

-- An After trigger indexes the folders a scan left unindexed, so it runs
-- incrementally whatever mode the Startup trigger had.
UPDATE workflow_trigger
SET trigger_type = 'after_workflow', display_name = 'Index after scan',
  schedule_json = '{"after":"local_library_scan"}', config_json = '{"mode":"incremental"}',
  next_run_at = NULL, updated_at = CURRENT_TIMESTAMP
WHERE trigger_type = 'startup'
  AND workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'local_media_index');

UPDATE workflow_trigger
SET trigger_type = 'after_workflow', display_name = 'Media details after Record scan',
  schedule_json = '{"after":"record_library_scan"}', config_json = '{}',
  next_run_at = NULL, updated_at = CURRENT_TIMESTAMP
WHERE trigger_type = 'startup'
  AND workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'record_media_probe');
