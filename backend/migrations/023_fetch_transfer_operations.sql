ALTER TABLE workflow_job
  ADD COLUMN progress_bytes_current INTEGER NOT NULL DEFAULT 0 CHECK(progress_bytes_current >= 0);

ALTER TABLE workflow_job
  ADD COLUMN progress_bytes_total INTEGER NOT NULL DEFAULT 0 CHECK(progress_bytes_total >= 0);

ALTER TABLE workflow_job
  ADD COLUMN progress_bytes_unknown_items INTEGER NOT NULL DEFAULT 0 CHECK(progress_bytes_unknown_items >= 0);

ALTER TABLE remote_fetch_manifest
  ADD COLUMN staging_cleaned_at TEXT;

CREATE INDEX idx_remote_fetch_manifest_staging_cleanup
  ON remote_fetch_manifest(staging_cleaned_at, state, updated_at, workflow_run_id);
