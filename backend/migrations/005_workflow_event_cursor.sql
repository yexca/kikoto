CREATE INDEX IF NOT EXISTS idx_workflow_event_run_id
  ON workflow_event(workflow_run_id, id);
