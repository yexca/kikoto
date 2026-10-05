ALTER TABLE party ADD COLUMN manual_name TEXT NOT NULL DEFAULT '';
ALTER TABLE party ADD COLUMN provider_name TEXT NOT NULL DEFAULT '';
UPDATE party SET provider_name=display_name;
CREATE INDEX idx_party_external_id_owner
 ON party_external_id(party_id,provider_id,id_type,is_primary DESC,id);
CREATE TABLE party_alias (
 id INTEGER PRIMARY KEY,
 party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
 alias TEXT NOT NULL CHECK(TRIM(alias)<>''),
 source TEXT NOT NULL DEFAULT 'manual',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(party_id,alias)
);
CREATE INDEX idx_party_alias_name ON party_alias(LOWER(alias));
CREATE TABLE party_merge_review (
 id INTEGER PRIMARY KEY,
 target_party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
 source_party_id INTEGER NOT NULL,
 target_name TEXT NOT NULL,
 source_name TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'merged' CHECK(status IN ('merged','undone')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 undone_at TEXT
);
CREATE INDEX idx_party_merge_review_target ON party_merge_review(target_party_id,status,id);

CREATE TRIGGER work_search_party_alias_insert AFTER INSERT ON party_alias
BEGIN
 INSERT INTO work_search_dirty(work_id) SELECT DISTINCT work_id FROM work_party WHERE party_id=NEW.party_id
   AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=work_party.work_id);
END;
CREATE TRIGGER work_search_party_alias_update AFTER UPDATE OF alias,party_id ON party_alias
BEGIN
 INSERT INTO work_search_dirty(work_id) SELECT DISTINCT work_id FROM work_party WHERE party_id IN (OLD.party_id,NEW.party_id)
   AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=work_party.work_id);
END;
CREATE TRIGGER work_search_party_alias_delete AFTER DELETE ON party_alias
BEGIN
 INSERT INTO work_search_dirty(work_id) SELECT DISTINCT work_id FROM work_party WHERE party_id=OLD.party_id
   AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=work_party.work_id);
END;
INSERT OR IGNORE INTO work_search_dirty(work_id) SELECT work_id FROM work_party;
