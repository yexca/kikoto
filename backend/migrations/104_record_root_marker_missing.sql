-- kikoto:foreign_keys=off
-- A record root whose path exists without the marker of the catalog the
-- database keeps is marker_missing: the catalog is kept and browsed, scans add
-- files without marking any missing, and an administrator restores the
-- marker. The manager runs this file with foreign key enforcement off so
-- dropping the old table does not cascade into record folders and assets,
-- then checks every reference.

CREATE TABLE record_root_next (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Records',
  configured_path TEXT NOT NULL DEFAULT '',
  marker_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK(state IN ('unconfigured', 'online', 'offline', 'unreadable', 'marker_missing')),
  last_scan_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  last_scanned_at TEXT,
  scan_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO record_root_next (
  id, display_name, configured_path, marker_id, enabled, state,
  last_scan_run_id, last_scanned_at, scan_generation, created_at, updated_at
)
SELECT
  id, display_name, configured_path, marker_id, enabled, state,
  last_scan_run_id, last_scanned_at, scan_generation, created_at, updated_at
FROM record_root;

DROP TABLE record_root;
ALTER TABLE record_root_next RENAME TO record_root;
