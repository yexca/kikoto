-- Custom workflow editing is removed. User-authored definitions and their
-- triggers are deleted; preset workflows replace them as system definitions.
-- Historical runs keep their workflow_code and display_name snapshots and only
-- lose the definition reference, so Activity history remains readable.

DELETE FROM workflow_trigger
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE scope = 'user');

UPDATE workflow_run
SET workflow_definition_id = NULL
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE scope = 'user');

DELETE FROM workflow_definition WHERE scope = 'user';
