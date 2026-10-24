-- A not-found metadata outcome may be dismissed, for example for a product the
-- provider no longer lists. An outcome with another status clears it.
ALTER TABLE work_metadata_sync_state ADD COLUMN dismissed_at TEXT;
