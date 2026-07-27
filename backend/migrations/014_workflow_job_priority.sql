ALTER TABLE workflow_job ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_workflow_job_claim_priority
  ON workflow_job(status, priority DESC, available_at, created_at, id);
