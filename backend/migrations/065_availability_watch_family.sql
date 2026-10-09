-- A watched code is satisfied by any edition of its work family. available_code
-- records the edition a remote source offered; metadata_synced_at bounds how
-- often a run refreshes the family metadata before checking availability.
ALTER TABLE availability_watch_target ADD COLUMN available_code TEXT NOT NULL DEFAULT '';
ALTER TABLE availability_watch_target ADD COLUMN metadata_synced_at TEXT;
UPDATE availability_watch_target SET available_code = work_code WHERE available_source_id IS NOT NULL;
