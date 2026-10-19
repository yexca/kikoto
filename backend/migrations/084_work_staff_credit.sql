-- DLsite credits a work's staff besides its voice actors: the author, the
-- scenario writer, the illustrator, the composer, and other staff. Each row is
-- one credited name projected from the work's latest DLsite snapshot, with
-- DLsite's creator id. Staff names are plain credits of the work, not people
-- in the voice actor catalog, so they never become voice actors, aliases, or
-- subscription subjects.
CREATE TABLE work_staff_credit (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('author', 'scenario', 'illustration', 'music', 'other')),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  provider_id INTEGER REFERENCES metadata_provider(id),
  external_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, role, name)
) WITHOUT ROWID;

CREATE INDEX idx_fk_work_staff_credit_provider_id ON work_staff_credit(provider_id);

-- The projection record gains the staff credit kind. Circle records are kept;
-- voice credit records are dropped, so the next pass projects every work's
-- voice credits once more and stores the DLsite creator id of each voice actor
-- its snapshot credits. Every work has no staff record yet, so the same pass
-- projects its staff credits.
CREATE TABLE work_snapshot_projection_kept AS
SELECT work_id, kind, snapshot_id, version, input_hash
FROM work_snapshot_projection
WHERE kind = 'dlsite_party';

DROP TABLE work_snapshot_projection;

CREATE TABLE work_snapshot_projection (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('voice_credit', 'dlsite_party', 'staff_credit')),
  snapshot_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  PRIMARY KEY(work_id, kind)
) WITHOUT ROWID;

INSERT INTO work_snapshot_projection (work_id, kind, snapshot_id, version, input_hash)
SELECT work_id, kind, snapshot_id, version, input_hash FROM work_snapshot_projection_kept;

DROP TABLE work_snapshot_projection_kept;

-- The search index gains one column per staff role. An FTS5 table cannot add
-- columns, so it is recreated and every work is queued for the background
-- rebuild.
DROP TABLE work_search;

CREATE VIRTUAL TABLE work_search USING fts5(
  code,
  title,
  circle,
  voice_actor,
  tag,
  staff_author,
  staff_scenario,
  staff_illustration,
  staff_music,
  staff_other,
  tokenize = 'trigram'
);

INSERT INTO work_search_dirty (work_id)
SELECT id FROM work WHERE id NOT IN (SELECT work_id FROM work_search_dirty);

CREATE TRIGGER work_search_staff_credit_insert
AFTER INSERT ON work_staff_credit
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_staff_credit_update
AFTER UPDATE OF work_id, role, name ON work_staff_credit
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_staff_credit_delete
AFTER DELETE ON work_staff_credit
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;
