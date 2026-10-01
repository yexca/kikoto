-- DLsite identifies a genre by a numeric id that is stable across request
-- locales: a product requested in another locale reports the same id with a
-- localized name, and name_base is always the Japanese name. Kikoto records
-- which ids each edition carries and learns a name for every locale it has
-- actually requested, so a tag search in one language also finds works whose
-- stored tags are written in another.
--
-- Names are keyed by the request locale rather than the edition language: an
-- edition in a language without its own locale is requested in ja-jp and its
-- genre names are Japanese. Both tables are metadata projections only. They do
-- not create works or tags, and a learned name never appears in tag lists.

CREATE TABLE dlsite_genre_name (
  genre_id INTEGER NOT NULL CHECK(genre_id > 0),
  language TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (genre_id, language)
);

CREATE TABLE work_dlsite_genre (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  genre_id INTEGER NOT NULL CHECK(genre_id > 0),
  PRIMARY KEY (work_id, genre_id)
);

CREATE INDEX idx_work_dlsite_genre_genre ON work_dlsite_genre(genre_id, work_id);

-- Backfill from each work's latest DLsite snapshot. Snapshots are visited
-- newest first so ON CONFLICT DO NOTHING keeps the most recent name.
CREATE TEMP TABLE migration_047_genre AS
WITH latest_snapshot AS (
  SELECT snapshot.work_id, snapshot.request_locale, snapshot.snapshot_json, snapshot.fetched_at, snapshot.id,
    ROW_NUMBER() OVER (PARTITION BY snapshot.work_id ORDER BY snapshot.fetched_at DESC, snapshot.id DESC) AS row_number
  FROM metadata_snapshot AS snapshot
  INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
  WHERE provider.code = 'dlsite'
    AND snapshot.work_id IS NOT NULL
)
SELECT
  latest_snapshot.work_id,
  LOWER(TRIM(COALESCE(latest_snapshot.request_locale, ''))) AS language,
  json_extract(genre.value, '$.id') AS genre_id,
  TRIM(COALESCE(json_extract(genre.value, '$.name'), '')) AS name,
  TRIM(COALESCE(json_extract(genre.value, '$.name_base'), '')) AS name_base,
  latest_snapshot.fetched_at,
  latest_snapshot.id AS snapshot_id
FROM latest_snapshot
INNER JOIN json_each(
  CASE
    WHEN json_type(latest_snapshot.snapshot_json, '$.product.genres') = 'array'
      THEN json_extract(latest_snapshot.snapshot_json, '$.product.genres')
    WHEN json_type(latest_snapshot.snapshot_json, '$.genres') = 'array'
      THEN json_extract(latest_snapshot.snapshot_json, '$.genres')
    ELSE '[]'
  END
) AS genre
WHERE latest_snapshot.row_number = 1
  AND json_type(genre.value, '$.id') = 'integer'
  AND json_extract(genre.value, '$.id') > 0;

INSERT INTO work_dlsite_genre (work_id, genre_id)
SELECT DISTINCT work_id, genre_id FROM migration_047_genre WHERE TRUE
ON CONFLICT(work_id, genre_id) DO NOTHING;

INSERT INTO dlsite_genre_name (genre_id, language, name)
SELECT genre_id, 'ja-jp', name_base FROM migration_047_genre
WHERE name_base <> ''
ORDER BY fetched_at DESC, snapshot_id DESC
ON CONFLICT(genre_id, language) DO NOTHING;

INSERT INTO dlsite_genre_name (genre_id, language, name)
SELECT genre_id, language, name FROM migration_047_genre
WHERE language <> '' AND name <> ''
ORDER BY fetched_at DESC, snapshot_id DESC
ON CONFLICT(genre_id, language) DO NOTHING;

DROP TABLE migration_047_genre;

CREATE TRIGGER work_search_dlsite_genre_insert
AFTER INSERT ON work_dlsite_genre
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_dlsite_genre_update
AFTER UPDATE OF work_id, genre_id ON work_dlsite_genre
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_dlsite_genre_delete
AFTER DELETE ON work_dlsite_genre
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;

CREATE TRIGGER work_search_dlsite_genre_name_insert
AFTER INSERT ON dlsite_genre_name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_dlsite_genre WHERE genre_id = NEW.genre_id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_dlsite_genre_name_update
AFTER UPDATE OF genre_id, name ON dlsite_genre_name
WHEN OLD.genre_id IS NOT NEW.genre_id OR OLD.name IS NOT NEW.name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_dlsite_genre WHERE genre_id IN (OLD.genre_id, NEW.genre_id)
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_dlsite_genre_name_delete
AFTER DELETE ON dlsite_genre_name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_dlsite_genre WHERE genre_id = OLD.genre_id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

INSERT INTO work_search_dirty (work_id)
SELECT DISTINCT work_id FROM work_dlsite_genre
WHERE work_id NOT IN (SELECT work_id FROM work_search_dirty);
