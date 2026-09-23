-- Library and voice cards read a few fields from the latest metadata snapshot.
-- Decoding the complete snapshot_json for every listed row is the dominant
-- cost of a page, so the application stores a compact, versioned card summary
-- derived from the snapshot and list queries read that instead.
--
-- The summary lives in its own table rather than in a new metadata_snapshot
-- column: an added column is stored after snapshot_json, and SQLite must walk
-- a large value's overflow pages to reach any column stored after it.
--
-- Summaries are written by the application. Triggers only queue snapshots in
-- metadata_snapshot_card_summary_dirty and drop a summary whose snapshot
-- content changed, so every snapshot writer stays correct without knowing the
-- summary format. A snapshot without a current summary is read directly until
-- the queue is drained.
--
-- Queue inserts skip already-queued snapshots instead of using INSERT OR
-- IGNORE: a conflict clause on the statement that fires a trigger overrides the
-- trigger's own clause.

CREATE TABLE metadata_snapshot_card_summary (
  snapshot_id INTEGER PRIMARY KEY REFERENCES metadata_snapshot(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE INDEX idx_metadata_snapshot_card_summary_version
  ON metadata_snapshot_card_summary(version);

CREATE TABLE metadata_snapshot_card_summary_dirty (
  snapshot_id INTEGER PRIMARY KEY REFERENCES metadata_snapshot(id) ON DELETE CASCADE
);

INSERT INTO metadata_snapshot_card_summary_dirty (snapshot_id)
SELECT id FROM metadata_snapshot;

CREATE TRIGGER metadata_snapshot_card_summary_insert
AFTER INSERT ON metadata_snapshot
BEGIN
  INSERT INTO metadata_snapshot_card_summary_dirty (snapshot_id)
  SELECT NEW.id WHERE NOT EXISTS (
    SELECT 1 FROM metadata_snapshot_card_summary_dirty WHERE snapshot_id = NEW.id
  );
END;

CREATE TRIGGER metadata_snapshot_card_summary_update
AFTER UPDATE OF snapshot_json ON metadata_snapshot
WHEN OLD.snapshot_json IS NOT NEW.snapshot_json
BEGIN
  DELETE FROM metadata_snapshot_card_summary WHERE snapshot_id = NEW.id;
  INSERT INTO metadata_snapshot_card_summary_dirty (snapshot_id)
  SELECT NEW.id WHERE NOT EXISTS (
    SELECT 1 FROM metadata_snapshot_card_summary_dirty WHERE snapshot_id = NEW.id
  );
END;
