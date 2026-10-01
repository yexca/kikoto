-- The work_search title column also holds the title of the work's own DLsite
-- language variant. The metadata priority projection may rewrite a canonical
-- work.title into another language, and the variant keeps the edition's own
-- title searchable after that rewrite. Sibling editions are still matched at
-- query time, so a work indexes only the variant stored for its own row.

CREATE TRIGGER work_search_variant_insert
AFTER INSERT ON dlsite_metadata_variant
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_variant_update
AFTER UPDATE OF work_id, title ON dlsite_metadata_variant
WHEN OLD.work_id IS NOT NEW.work_id OR OLD.title IS NOT NEW.title
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_variant_delete
AFTER DELETE ON dlsite_metadata_variant
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;

INSERT INTO work_search_dirty (work_id)
SELECT id FROM work
WHERE id IN (SELECT work_id FROM dlsite_metadata_variant)
  AND id NOT IN (SELECT work_id FROM work_search_dirty);
