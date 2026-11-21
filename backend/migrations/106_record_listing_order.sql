-- A record folder lists its children in natural name order, the order the
-- browser shows them in, and names its artwork without reading files on each
-- listing. sort_key is the natural-order collation key the record store
-- computes from the name; poster_asset_id and backdrop_asset_id are the
-- images a scan chose and checked as the folder's artwork. The store fills
-- these in for the existing catalog, and again whenever the collation it
-- computes keys with changes, when derived_version differs from its own.

ALTER TABLE record_folder ADD COLUMN sort_key BLOB;
ALTER TABLE record_folder ADD COLUMN poster_asset_id INTEGER REFERENCES record_asset(id) ON DELETE SET NULL;
ALTER TABLE record_folder ADD COLUMN backdrop_asset_id INTEGER REFERENCES record_asset(id) ON DELETE SET NULL;
ALTER TABLE record_asset ADD COLUMN sort_key BLOB;
ALTER TABLE record_root ADD COLUMN derived_version INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_record_folder_parent;
CREATE INDEX idx_record_folder_parent
  ON record_folder(parent_id, state, sort_key, name, id);

CREATE INDEX idx_record_asset_folder_order
  ON record_asset(folder_id, availability, sort_key, name, id);
