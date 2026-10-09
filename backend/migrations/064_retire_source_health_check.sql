-- The source_health_check system definition is retired; source_presence_check
-- probes source health before it checks works. Its triggers are deleted.
-- Historical runs keep their workflow_code and display_name snapshots and only
-- lose the definition reference, so Activity history remains readable.

DELETE FROM workflow_trigger
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'source_health_check');

UPDATE workflow_run
SET workflow_definition_id = NULL
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'source_health_check');

DELETE FROM workflow_definition WHERE code = 'source_health_check';
