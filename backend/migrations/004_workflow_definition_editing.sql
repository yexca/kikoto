ALTER TABLE workflow_definition
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'system' CHECK(scope IN ('system', 'user'));

ALTER TABLE workflow_definition
  ADD COLUMN editable INTEGER NOT NULL DEFAULT 0 CHECK(editable IN (0, 1));

ALTER TABLE workflow_definition
  ADD COLUMN owner_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL;

ALTER TABLE workflow_definition
  ADD COLUMN created_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL;

CREATE TRIGGER validate_workflow_definition_insert
BEFORE INSERT ON workflow_definition
BEGIN
  SELECT CASE
    WHEN NEW.scope = 'system' AND NEW.editable != 0
      THEN RAISE(ABORT, 'system workflow definitions are not editable')
    WHEN NEW.scope = 'system' AND NEW.owner_user_id IS NOT NULL
      THEN RAISE(ABORT, 'system workflow definitions cannot have an owner')
    WHEN NEW.scope = 'user' AND NEW.editable != 1
      THEN RAISE(ABORT, 'user workflow definitions must be editable')
  END;
END;

CREATE TRIGGER validate_workflow_definition_update
BEFORE UPDATE ON workflow_definition
BEGIN
  SELECT CASE
    WHEN NEW.scope = 'system' AND NEW.editable != 0
      THEN RAISE(ABORT, 'system workflow definitions are not editable')
    WHEN NEW.scope = 'system' AND NEW.owner_user_id IS NOT NULL
      THEN RAISE(ABORT, 'system workflow definitions cannot have an owner')
    WHEN NEW.scope = 'user' AND NEW.editable != 1
      THEN RAISE(ABORT, 'user workflow definitions must be editable')
  END;
END;

CREATE TRIGGER validate_workflow_trigger_insert
BEFORE INSERT ON workflow_trigger
BEGIN
  SELECT CASE
    WHEN NEW.trigger_type NOT IN ('startup', 'schedule', 'filesystem_event', 'source_poll')
      THEN RAISE(ABORT, 'invalid workflow trigger type')
  END;
END;

CREATE TRIGGER validate_workflow_trigger_update
BEFORE UPDATE ON workflow_trigger
BEGIN
  SELECT CASE
    WHEN NEW.trigger_type NOT IN ('startup', 'schedule', 'filesystem_event', 'source_poll')
      THEN RAISE(ABORT, 'invalid workflow trigger type')
  END;
END;

CREATE INDEX idx_workflow_definition_scope
  ON workflow_definition(scope, editable);

CREATE INDEX idx_workflow_definition_owner
  ON workflow_definition(owner_user_id);
