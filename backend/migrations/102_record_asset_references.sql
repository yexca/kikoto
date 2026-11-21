-- Every table that references a record file has an index on that column, so
-- deleting files, as forgetting a catalog or trashing a folder does, checks
-- each reference through an index instead of scanning the table once per
-- deleted file. Most folders choose no artwork, so the artwork indexes hold
-- only the folders that do.

CREATE INDEX idx_record_asset_progress_asset ON record_asset_progress(asset_id);

CREATE INDEX idx_record_asset_state_asset ON record_asset_state(asset_id);

CREATE INDEX idx_record_folder_poster
  ON record_folder(poster_asset_id) WHERE poster_asset_id IS NOT NULL;

CREATE INDEX idx_record_folder_backdrop
  ON record_folder(backdrop_asset_id) WHERE backdrop_asset_id IS NOT NULL;
