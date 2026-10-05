-- Remote metadata fallback. A normalized work field filled from a remote
-- source records that source while the work has no DLsite metadata. The
-- reconciler rewrites these rows from the stored remote snapshots, so the
-- configured source order decides the result rather than the write order.
CREATE TABLE work_metadata_field_source (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL CHECK(field_name IN ('title', 'release_date', 'age_rating', 'duration', 'circle', 'tags', 'cover')),
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, field_name)
) WITHOUT ROWID;
CREATE INDEX idx_fk_work_metadata_field_source_provider_id ON work_metadata_field_source(provider_id);

-- Localized names a remote source declared for a shared tag concept without a
-- DLsite genre id. They rank after manual names, fill only absent cells, and
-- are never replaced by a later response.
CREATE TABLE metadata_tag_provider_name (
  tag_id INTEGER NOT NULL REFERENCES metadata_tag(tag_id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK(language IN ('', 'ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  name TEXT NOT NULL CHECK(TRIM(name) <> '' AND LENGTH(CAST(name AS BLOB)) <= 512),
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(tag_id, language)
) WITHOUT ROWID;
CREATE INDEX idx_fk_metadata_tag_provider_name_provider_id ON metadata_tag_provider_name(provider_id);

CREATE TRIGGER work_search_metadata_tag_provider_name_insert AFTER INSERT ON metadata_tag_provider_name
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (NEW.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_provider_name_update AFTER UPDATE OF name,language ON metadata_tag_provider_name
WHEN OLD.name IS NOT NEW.name OR OLD.language IS NOT NEW.language
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (OLD.tag_id,NEW.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_provider_name_delete AFTER DELETE ON metadata_tag_provider_name
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (OLD.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;

-- Existing remote snapshots were applied in write order. Reconcile every work
-- that has one through the durable projection queue so its normalized fields
-- and provenance follow the deterministic source order.
INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
SELECT DISTINCT snapshot.work_id
FROM metadata_snapshot AS snapshot
JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
JOIN work ON work.id = snapshot.work_id
WHERE provider.code GLOB 'kikoeru_source_*';
