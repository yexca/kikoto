ALTER TABLE workflow_job ADD COLUMN resource_key TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_workflow_job_resource_status
ON workflow_job(resource_key, status, priority DESC, created_at, id);
